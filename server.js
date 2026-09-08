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
    console.log('✅ [Módulo 1] Conexión exitosa a la Base de Datos nexo_db');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error de conexión a la Base de Datos:', err.message);
  });

const usuariosConectados = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // 1. REGISTRAR USUARIO
  socket.on('registrar_usuario', (id_usuario) => {
    if (!id_usuario) return;
    usuariosConectados.set(String(id_usuario), socket.id);
    console.log(`👤 Usuario ${id_usuario} vinculado al Socket ${socket.id}`);
  });

  // --- EVENTOS WEBRTC (LLAMADAS Y VIDEOLLAMADAS) ---
  io.on('connection', (socket) => {
  // Cuando el cliente nos dice qué ID de usuario es
  socket.on('registrar_usuario', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`Socket ${socket.id} registrado en la sala user_${userId}`);
  });

  // --- EVENTOS WEBRTC ---
  socket.on('iniciar_llamada', (data) => {
    // Reenviar evento directamente a la sala del receptor
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
});

  // 2. EVENTO: USUARIO ESCRIBIENDO
  socket.on('escribiendo', (data) => {
    const socketReceptor = usuariosConectados.get(String(data.receptor_id));
    if (socketReceptor) {
      io.to(socketReceptor).emit('usuario_escribiendo', {
        emisor_id: data.emisor_id,
        escribiendo: true
      });
    }
  });

  // 3. EVENTO: USUARIO DETUVO ESCRITURA
  socket.on('detuvo_escribiendo', (data) => {
    const socketReceptor = usuariosConectados.get(String(data.receptor_id));
    if (socketReceptor) {
      io.to(socketReceptor).emit('usuario_escribiendo', {
        emisor_id: data.emisor_id,
        escribiendo: false
      });
    }
  });

  // 4. MARCAR LEÍDO
  socket.on('marcar_leido', async (data) => {
    const id_emisor = data?.id_emisor ?? data?.remitente_id ?? null;
    const id_receptor = data?.id_receptor ?? data?.receptor_id ?? null;

    if (!id_emisor || !id_receptor) {
      console.log('⚠️ Faltan parámetros id_emisor o id_receptor para marcar leído:', data);
      return;
    }

    try {
      const query = 'UPDATE mensajes SET estado = "leido" WHERE id_emisor = ? AND id_receptor = ? AND estado != "leido"';
      await db.query(query, [id_emisor, id_receptor]);

      console.log(`📩 Mensajes marcados como leídos de ${id_emisor} para ${id_receptor}`);

      const socketEmisor = usuariosConectados.get(String(id_emisor));
      if (socketEmisor) {
        io.to(socketEmisor).emit('actualizar_estado_mensajes', {
          id_emisor,
          id_receptor,
          estado: 'leido'
        });
      }
    } catch (error) {
      console.error('❌ Error al actualizar estado del mensaje:', error.message);
    }
  });

  // 5. ENVIAR MENSAJE
  socket.on('enviar_mensaje', async (datos) => {
    const id_emisor = datos?.id_emisor ?? null;
    const id_receptor = datos?.id_receptor ?? null;
    const contenido = datos?.contenido ?? '';
    const tipo_contenido = datos?.tipo_contenido ?? 'texto';

    if (!id_emisor || !id_receptor) {
      console.log('⚠️ Datos inválidos al enviar mensaje:', datos);
      return;
    }

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

  // 6. DESCONEXIÓN
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

// Endpoint HTTP GET para obtener el historial de mensajes
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 [Módulo 2] Servidor Nexo activo en el puerto ${PORT}`);
});

// server.js - Endpoint para traducción de Frases a Pictogramas DUA
app.get('/api/traducir-pictogramas', async (req, res) => {
  const { texto } = req.query;
  if (!texto) return res.status(400).json({ error: 'Texto requerido' });

  // Lista de palabras a ignorar para enfocar la frase en pictogramas clave
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
          const id = data[0]._id;
          secuenciaPictogramas.push({
            palabra: palabra,
            url: `https://api.arasaac.org/v1/pictograms/${id}?download=false`
          });
        }
      }
    } catch (err) {
      console.error(`Error buscando pictograma para: ${palabra}`, err);
    }
  }

  res.json({ textoOriginal: texto, pictogramas: secuenciaPictogramas });
});