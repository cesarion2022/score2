import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// RED: Sirve los archivos estáticos de la carpeta public (contiene index.html)
app.use(express.static(path.join(__dirname, 'public')));

// RED: Estado global en memoria del servidor
const state = {
  init: false,
  sc: [0, 0, 0, 0, 0, 0],
  sets: [0, 0, 0, 0, 0, 0],
  names: ['Jugador 1', 'Jugador 2', 'Jugador 3', 'Jugador 4', 'Jugador 5', 'Jugador 6'],
  n: 2,
  el: 0,
  run: false,
  last: 0,
  cart: {},
  mesa: 1,
  rate: 17000,
  closed: false,
};

// RED: Calcula el tiempo transcurrido exacto al vuelo cuando un nuevo espectador se conecta
function getLiveState() {
  if (!state.run || !state.last) return state;
  return {
    ...state,
    el: state.el + Math.max(0, Date.now() - state.last),
    last: Date.now(),
  };
}

function getLocalIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) {
        ips.push({ iface: name, address: net.address });
      }
    }
  }
  return ips;
}

io.on('connection', (socket) => {
  socket.data.role = 'viewer';

  // RED: Al conectarse un dispositivo nuevo, recibe el estado actual de inmediato
  socket.emit('state', getLiveState());

  // RED: Registro de rol ('host' o 'viewer')
  socket.on('hello', (info = {}) => {
    socket.data.role = info.role === 'host' ? 'host' : 'viewer';
    console.log(`[Socket.IO] Conectado ${socket.data.role} (${socket.id}) · Total clientes: ${io.engine.clientsCount}`);
  });

  // RED: El host envía un objeto parcial, el servidor lo fusiona y retransmite a todos
  socket.on('update', (patch) => {
    if (socket.data.role !== 'host') return;
    if (!patch || typeof patch !== 'object') return;

    Object.assign(state, patch);
    state.init = true;
    if (state.run && !patch.last) {
      state.last = Date.now();
    }

    io.emit('state', state);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Desconectado ${socket.data.role} (${socket.id}) · Total clientes: ${io.engine.clientsCount}`);
  });
});

server.listen(PORT, HOST, () => {
  const ips = getLocalIPs();
  console.log('====================================================');
  console.log(' 🎱 Billar Pro · Servidor en Red Local activo');
  console.log('----------------------------------------------------');
  console.log(` Host (control):       http://localhost:${PORT}`);
  if (ips.length) {
    ips.forEach(({ iface, address }) => {
      console.log(` Espectadores (${iface}): http://${address}:${PORT}`);
    });
  } else {
    console.log(` Espectadores:         http://<IP_DEL_HOST>:${PORT}`);
  }
  console.log('====================================================');
});
