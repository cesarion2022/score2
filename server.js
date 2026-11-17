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
const MAX_TABLES = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// RED: Sirve los archivos estáticos de la carpeta public (contiene index.html)
app.use(express.static(path.join(__dirname, 'public')));

function clampMesa(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_TABLES, Math.max(1, Math.trunc(n)));
}

function createTableState(mesaId) {
  return {
    init: false,
    sc: [0, 0, 0, 0, 0, 0],
    sets: [0, 0, 0, 0, 0, 0],
    names: ['Jugador 1', 'Jugador 2', 'Jugador 3', 'Jugador 4', 'Jugador 5', 'Jugador 6'],
    n: 2,
    el: 0,
    run: false,
    last: 0,
    cart: {},
    mesa: mesaId,
    rate: 17000,
    closed: false,
    stationName: `Mesa ${mesaId}`,
  };
}

// RED: Estado global en memoria para 10 estaciones de trabajo (Mesas 1..10)
const tables = {};
for (let i = 1; i <= MAX_TABLES; i++) {
  tables[i] = createTableState(i);
}

// RED: Calcula el tiempo transcurrido exacto al vuelo para cualquier mesa
function getLiveState(mesaId) {
  const st = tables[clampMesa(mesaId)];
  if (!st.run || !st.last) return st;
  return {
    ...st,
    el: st.el + Math.max(0, Date.now() - st.last),
    last: Date.now(),
  };
}

function getRoomClientCount(mesaId) {
  const room = io.sockets.adapter.rooms.get(`table:${mesaId}`);
  return room ? room.size : 0;
}

function getStationsSummary() {
  const list = [];
  for (let i = 1; i <= MAX_TABLES; i++) {
    const live = getLiveState(i);
    list.push({
      ...live,
      clients: getRoomClientCount(i),
    });
  }
  return list;
}

function emitStations() {
  io.emit('stations', getStationsSummary());
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
  socket.data.mesa = 1;
  socket.join('table:1');

  // RED: Al conectarse un dispositivo nuevo, recibe el estado de su mesa y el resumen de estaciones
  socket.emit('state', getLiveState(1));
  socket.emit('stations', getStationsSummary());

  // RED: Registro de rol ('host' o 'viewer') y mesa (1..10)
  socket.on('hello', (info = {}) => {
    const prevMesa = socket.data.mesa;
    const nextMesa = clampMesa(info.mesa || 1);
    socket.data.role = info.role === 'host' ? 'host' : 'viewer';
    socket.data.mesa = nextMesa;

    if (prevMesa !== nextMesa) {
      socket.leave(`table:${prevMesa}`);
      socket.join(`table:${nextMesa}`);
    }

    socket.emit('state', getLiveState(nextMesa));
    emitStations();
    console.log(`[Socket.IO] ${socket.data.role} en Mesa ${nextMesa} (${socket.id}) · Total: ${io.engine.clientsCount}`);
  });

  // RED: El host envía un objeto parcial, el servidor lo fusiona en esa mesa y retransmite
  socket.on('update', (patch) => {
    if (socket.data.role !== 'host') return;
    if (!patch || typeof patch !== 'object') return;

    const mesaId = clampMesa(patch.mesa ?? socket.data.mesa ?? 1);
    const st = tables[mesaId];
    Object.assign(st, patch, { mesa: mesaId });
    st.init = true;
    if (st.run && !patch.last) {
      st.last = Date.now();
    }

    io.to(`table:${mesaId}`).emit('state', st);
    emitStations();
  });

  // RED: Hidratar múltiples mesas desde Firestore al iniciar sesión en el host
  socket.on('stations:hydrate', (list) => {
    if (socket.data.role !== 'host' || !Array.isArray(list)) return;
    list.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = clampMesa(item.mesa);
      const st = tables[id];
      if (!st.init) {
        Object.assign(st, item, { mesa: id, init: true });
        io.to(`table:${id}`).emit('state', getLiveState(id));
      }
    });
    emitStations();
  });

  // RED: Comandos remotos desde el Administrador sobre cualquiera de las 10 mesas
  socket.on('station:cmd', (cmd = {}) => {
    if (socket.data.role !== 'host') return;
    const id = clampMesa(cmd.mesa);
    const st = tables[id];

    if (cmd.action === 'toggle') {
      if (st.run && st.last) {
        st.el = st.el + Math.max(0, Date.now() - st.last);
        st.run = false;
        st.last = Date.now();
      } else {
        st.run = true;
        st.last = Date.now();
      }
      st.init = true;
    } else if (cmd.action === 'reset') {
      const keepName = st.stationName;
      const keepRate = st.rate;
      const keepCfg = st.cfg;
      const keepN = st.n;
      const keepNames = st.names;
      Object.assign(st, createTableState(id), {
        init: true,
        stationName: keepName,
        rate: keepRate,
        cfg: keepCfg,
        n: keepN,
        names: keepNames,
      });
    } else if (cmd.action === 'close') {
      if (st.run && st.last) {
        st.el = st.el + Math.max(0, Date.now() - st.last);
      }
      st.run = false;
      st.last = Date.now();
      st.closed = true;
      st.init = true;
    } else if (cmd.action === 'rate') {
      const r = Number(cmd.rate);
      if (Number.isFinite(r) && r >= 0) {
        st.rate = r;
        st.init = true;
      }
    } else if (cmd.action === 'rename') {
      st.stationName = String(cmd.stationName || `Mesa ${id}`).slice(0, 40);
      st.init = true;
    } else {
      return;
    }

    io.to(`table:${id}`).emit('state', getLiveState(id));
    emitStations();
  });

  socket.on('disconnect', () => {
    emitStations();
    console.log(`[Socket.IO] Desconectado ${socket.data.role} (${socket.id}) · Total: ${io.engine.clientsCount}`);
  });
});

server.listen(PORT, HOST, () => {
  const ips = getLocalIPs();
  console.log('====================================================');
  console.log(' 🎱 Billar Pro · 10 Estaciones en Red Local');
  console.log('----------------------------------------------------');
  console.log(` Host / Admin:         http://localhost:${PORT}`);
  if (ips.length) {
    ips.forEach(({ iface, address }) => {
      console.log(` Estación N (${iface}): http://${address}:${PORT}/?mesa=1`);
    });
  } else {
    console.log(` Espectadores:         http://<IP_DEL_HOST>:${PORT}/?mesa=1`);
  }
  console.log('====================================================');
});
