const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nexo_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection()
  .then(conn => {
    console.log('✅ Conexión exitosa a la Base de Datos');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error de conexión a la Base de Datos:', err.message);
  });

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN Y CONTACTOS
// ==========================================

// Login / Registro por número de teléfono
// Login / Registro por número de teléfono
app.post('/api/auth/login-telefono', async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono) return res.status(400).json({ error: 'El teléfono es requerido' });

  const nombreFinal = nombre && nombre.trim() !== '' ? nombre : 'Nuevo Usuario';

  try {
    const [users] = await db.query('SELECT * FROM usuarios WHERE telefono = ?', [telefono]);

    if (users.length === 0) {
      const [result] = await db.query(
        'INSERT INTO usuarios (nombre, telefono) VALUES (?, ?)',
        [nombreFinal, telefono]
      );
      return res.json({ 
        id_usuario: result.insertId, 
        nombre: nombreFinal, 
        telefono: telefono 
      });
    }

    // Aseguramos que la respuesta devuelva siempre id_usuario
    const usuarioExistente = users[0];
    res.json({
      id_usuario: usuarioExistente.id_usuario || usuarioExistente.id,
      nombre: usuarioExistente.nombre,
      telefono: usuarioExistente.telefono
    });

  } catch (err) {
    console.error('Error en login-telefono:', err);
    res.status(500).json({ error: 'Error interno en el servidor' });
  }
});

// Enviar Invitación de Contacto
app.post('/api/contactos/invitar', async (req, res) => {
  const { mi_id, telefono_contacto } = req.body;
  try {
    const [target] = await db.query('SELECT id_usuario FROM usuarios WHERE telefono = ?', [telefono_contacto]);
    if (target.length === 0) {
      return res.status(404).json({ error: 'El número no pertenece a un usuario registrado' });
    }

    const contactoId = target[0].id_usuario;
    if (mi_id === contactoId) {
      return res.status(400).json({ error: 'No puedes enviarte una invitación a ti mismo' });
    }

    await db.query(
      'INSERT INTO contactos (usuario_id, contacto_id, estado) VALUES (?, ?, "pendiente") ON DUPLICATE KEY UPDATE estado = estado',
      [mi_id, contactoId]
    );
    res.json({ mensaje: 'Invitación enviada exitosamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al enviar invitación' });
  }
});

// Aceptar / Rechazar Invitación
app.post('/api/contactos/responder', async (req, res) => {
  const { mi_id, contacto_id, aceptar } = req.body;
  const nuevoEstado = aceptar ? 'aceptado' : 'bloqueado';

  try {
    await db.query(
      'UPDATE contactos SET estado = ? WHERE usuario_id = ? AND contacto_id = ?',
      [nuevoEstado, contacto_id, mi_id]
    );

    if (aceptar) {
      await db.query(
        'INSERT INTO contactos (usuario_id, contacto_id, estado) VALUES (?, ?, "aceptado") ON DUPLICATE KEY UPDATE estado = "aceptado"',
        [mi_id, contacto_id]
      );
    }
    res.json({ mensaje: `Invitación ${aceptar ? 'aceptada' : 'rechazada'}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar la respuesta' });
  }
});

// Lista de Contactos Aceptados
app.get('/api/contactos/aceptados/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id_usuario, u.nombre, u.telefono, u.estado_dua 
      FROM contactos c
      JOIN usuarios u ON c.contacto_id = u.id_usuario
      WHERE c.usuario_id = ? AND c.estado = 'aceptado'
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener contactos' });
  }
});

// Historial de Mensajes
app.get('/api/mensajes/:emisor/:receptor', async (req, res) => {
  const { emisor, receptor } = req.params;
  try {
    const sql = `
      SELECT * FROM mensajes 
      WHERE (id_emisor = ? AND id_receptor = ?) 
         OR (id_emisor = ? AND id_receptor = ?)
      ORDER BY fecha_envio ASC
    `;
    const [filas] = await db.execute(sql, [emisor, receptor, receptor, emisor]);
    res.json(filas);
  } catch (error) {
    console.error('❌ Error al obtener mensajes:', error.message);
    res.status(500).json({ error: 'Error al consultar la base de datos' });
  }
});

// Traductor DUA (ARASAAC)
app.get('/api/traducir-pictogramas', async (req, res) => {
  const { texto } = req.query;
  if (!texto) return res.status(400).json({ error: 'Texto requerido' });

  const stopwords = ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al', 'que', 'en', 'para', 'por', 'con'];
  const palabras = texto
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
    .split(/\s+/)
    .filter(p => !stopwords.includes(p) && p.length > 0);

  const secuenciaPictogramas = [];
  for (const palabra of palabras) {
    try {
      const response = await fetch(`https://api.arasaac.org/v1/pictograms/es/search/${encodeURIComponent(palabra)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.length > 0) {
          secuenciaPictogramas.push({
            palabra: palabra,
            url: `https://api.arasaac.org/v1/pictograms/${data[0]._id}?download=false`
          });
        }
      }
    } catch (err) {
      console.error(`Error buscando pictograma para: ${palabra}`, err);
    }
  }
  res.json({ textoOriginal: texto, pictogramas: secuenciaPictogramas });
});

// ==========================================
// SOCKET.IO (CHAT Y WEBRTC EN TIEMPO REAL)
// ==========================================

const usuariosConectados = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // Registrar Usuario y Unir a su Sala
  socket.on('registrar_usuario', (id_usuario) => {
    if (!id_usuario) return;
    usuariosConectados.set(String(id_usuario), socket.id);
    socket.join(`user_${id_usuario}`);
    console.log(`👤 Usuario ${id_usuario} vinculado a la sala user_${id_usuario} y Socket ${socket.id}`);
  });

  // Eventos WebRTC
  socket.on('iniciar_llamada', (data) => {
    io.to(`user_${data.receptorId}`).emit('llamada_entrante', data);
  });

  socket.on('responder_llamada', (data) => {
    io.to(`user_${data.emisorId}`).emit('llamada_aceptada', data);
  });

  socket.on('ice_candidate', (data) => {
    io.to(`user_${data.targetId}`).emit('ice_candidate', data);
  });

  socket.on('colgar_llamada', (data) => {
    io.to(`user_${data.targetId}`).emit('llamada_finalizada');
  });

  // Indicador "Escribiendo..."
  socket.on('escribiendo', (data) => {
    const socketReceptor = usuariosConectados.get(String(data.receptor_id));
    if (socketReceptor) {
      io.to(socketReceptor).emit('usuario_escribiendo', { emisor_id: data.emisor_id, escribiendo: true });
    }
  });

  socket.on('detuvo_escribiendo', (data) => {
    const socketReceptor = usuariosConectados.get(String(data.receptor_id));
    if (socketReceptor) {
      io.to(socketReceptor).emit('usuario_escribiendo', { emisor_id: data.emisor_id, escribiendo: false });
    }
  });

  // Marcar Mensajes como Leídos
  socket.on('marcar_leido', async (data) => {
    const id_emisor = data?.id_emisor ?? data?.remitente_id ?? null;
    const id_receptor = data?.id_receptor ?? data?.receptor_id ?? null;
    if (!id_emisor || !id_receptor) return;

    try {
      await db.query('UPDATE mensajes SET estado = "leido" WHERE id_emisor = ? AND id_receptor = ? AND estado != "leido"', [id_emisor, id_receptor]);
      const socketEmisor = usuariosConectados.get(String(id_emisor));
      if (socketEmisor) {
        io.to(socketEmisor).emit('actualizar_estado_mensajes', { id_emisor, id_receptor, estado: 'leido' });
      }
    } catch (error) {
      console.error('❌ Error al actualizar estado del mensaje:', error.message);
    }
  });

  // Enviar Mensaje de Chat
  socket.on('enviar_mensaje', async (datos) => {
    const id_emisor = datos?.id_emisor ?? null;
    const id_receptor = datos?.id_receptor ?? null;
    const contenido = datos?.contenido ?? '';
    const tipo_contenido = datos?.tipo_contenido ?? 'texto';

    if (!id_emisor || !id_receptor) return;

    try {
      const sql = 'INSERT INTO mensajes (id_emisor, id_receptor, contenido, tipo_contenido, estado) VALUES (?, ?, ?, ?, "enviado")';
      const [resultado] = await db.execute(sql, [id_emisor, id_receptor, contenido, tipo_contenido]);

      const mensajeGuardado = {
        id_mensaje: resultado.insertId,
        id_emisor,
        id_receptor,
        contenido,
        tipo_contenido,
        estado: 'enviado',
        fecha_envio: new Date()
      };

      const socketReceptor = usuariosConectados.get(String(id_receptor));
      if (socketReceptor) {
        io.to(socketReceptor).emit('recibir_mensaje', mensajeGuardado);
      }
      socket.emit('mensaje_enviado_confirmacion', mensajeGuardado);
    } catch (error) {
      console.error('❌ Error al procesar mensaje:', error.message);
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    for (let [id_usuario, socketId] of usuariosConectados.entries()) {
      if (socketId === socket.id) {
        usuariosConectados.delete(id_usuario);
        console.log(`❌ Usuario ${id_usuario} desconectado`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Nexo activo en el puerto ${PORT}`);
});
