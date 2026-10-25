const http = require("http");
//st http = require("http");
const https = require("https");
const WebSocket = require("ws");

const PORT = process.env.PORT || 7860;
const HF_WORKER_URL =
  "https://huggingface.co/spaces/Itachi636777/legend-of-fairy-tail/resolve/main/hf_worker.js";

//nst WebSocket = require("ws");

// Render Singapore Server automatically injects process.env.PORT (10000); fallback 7860 for HF/Local
//const PORT = process.env.PORT || 7860;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    "Legend of Fairy Tail 16-Fighter Server (Render Singapore + HF Static) is Running Live! 🟢"
  );
});

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false, // Zero CPU compression delay for 60 FPS packets
  maxPayload: 1024 * 1024, // 1MB buffer for 16-fighter state sync
});

// 🧠 REALTIME MEMORY DATABASE FOR AUTHORITATIVE SERVER
const rooms = {};

function sendSafe(client, payloadStr) {
  if (client && client.readyState === WebSocket.OPEN) {
    try {
      client.send(payloadStr);
    } catch (e) {}
  }
}

function broadcastToRoomGuests(room, payloadStr, excludeWs = null) {
  if (!room || !room.guests) return;
  for (let i = 0; i < room.guests.length; i++) {
    const g = room.guests[i];
    if (g !== excludeWs && g.readyState === WebSocket.OPEN) {
      try {
        g.send(payloadStr);
      } catch (e) {}
    }
  }
}
// ⚡ CLOUD CO-PROCESSOR: Offloads 16-Fighter Target Radar & AABB Collision Math from Host Phone
function isBoxColliding(r1, r2) {
  if (!r1 || !r2) return false;
  return (
    r1.x < r2.x + r2.w &&
    r1.x + r1.w > r2.x &&
    r1.y < r2.y + r2.h &&
    r1.y + r1.h > r2.y
  );
}

function runCloudCoProcessor(fighters, projectiles) {
  const targetMap = {};
  const hits = [];
  if (!Array.isArray(fighters)) return { targetMap, hits };

  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f || f.health <= 0) continue;
    let minDist = Infinity;
    let bestTargetId = null;
    for (let j = 0; j < fighters.length; j++) {
      if (i === j) continue;
      const other = fighters[j];
      if (!other || other.health <= 0 || other.team === f.team) continue;
      const d = Math.abs((other.x || 0) - (f.x || 0));
      if (d < minDist) {
        minDist = d;
        bestTargetId = other.id;
      }
    }
    if (bestTargetId) {
      targetMap[f.id] = { targetId: bestTargetId, dist: Math.round(minDist) };
    }
  }

  if (Array.isArray(projectiles) && projectiles.length > 0) {
    for (let pIdx = 0; pIdx < projectiles.length; pIdx++) {
      const p = projectiles[pIdx];
      if (!p) continue;
      const pBox = {
        x: p.x || 0,
        y: p.y || 0,
        w: p.w || p.cachedW || p._cachedW || 40,
        h: p.h || p.cachedH || p._cachedH || 40,
      };
      for (let fIdx = 0; fIdx < fighters.length; fIdx++) {
        const f = fighters[fIdx];
        if (!f || f.health <= 0 || f.team === p.ownerTeam) continue;
        const fBox = {
          x: f.x || 0,
          y: f.y || 40,
          w: f.fw || f._cachedWidth || 50,
          h: f.fh || f._cachedHeight || 60,
        };
        if (isBoxColliding(pBox, fBox)) {
          hits.push({ projIdx: pIdx, victimId: f.id });
        }
      }
    }
  }

  return { targetMap, hits };
}
function syncHuggingFaceWorkerCode() {
  try {
    https
      .get(HF_WORKER_URL, (res) => {
        if (res.statusCode === 200) {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            console.log(
              "🟢 Synced hf_worker.js from Hugging Face Space into Render RAM!"
            );
          });
        }
      })
      .on("error", () => {});
  } catch (e) {}
}
syncHuggingFaceWorkerCode();

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.isHost = false;
  ws.guestId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (message) => {
    try {
      const rawStr = message.toString();
      const data = JSON.parse(rawStr);

      // 1. Host creates / opens a room
      if (data.type === "host_create_room") {
        const code = String(data.roomCode || "").trim();
        if (!code) return;
        ws.roomCode = code;
        ws.isHost = true;
        if (!rooms[code]) {
          rooms[code] = {
            host: ws,
            guests: [],
            members: data.members || [],
            myTeam: data.myTeam || [],
            enemyTeam: data.enemyTeam || [],
            gameState: { fighters: {}, projectiles: [] },
          };
        } else {
          if (rooms[code].cleanupTimer) {
            clearTimeout(rooms[code].cleanupTimer);
            rooms[code].cleanupTimer = null;
          }

          rooms[code].host = ws;
          rooms[code].members = data.members || rooms[code].members;
          rooms[code].myTeam = data.myTeam || rooms[code].myTeam;
          rooms[code].enemyTeam = data.enemyTeam || rooms[code].enemyTeam;
        }
        sendSafe(ws, JSON.stringify({ type: "room_created", roomCode: code }));
      }

      // 2. Guest joins a room by 4-digit code
      /*else if (
        data.type === "guest_join_request" ||
        data.type === "join_request"
      ) {*/
      else if (
        data.type === "guest_join_request" ||
        data.type === "join_request" ||
        data.type === "rejoin_match_request"
      ) {
        const code = String(data.roomCode || ws.roomCode || "").trim();
        const room = rooms[code];
        if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
          sendSafe(
            ws,
            JSON.stringify({
              type: "error",
              message: "Host not online on Room #" + code,
            })
          );
          return;
        }

        ws.roomCode = code;
        ws.isHost = false;
        ws.guestId =
          data.guestId ||
          data.senderRoomCode ||
          "guest_" + Math.random().toString(36).substr(2, 5);

        if (!room.guests.includes(ws)) {
          room.guests.push(ws);
        }

        sendSafe(
          room.host,
          JSON.stringify({
            //type: "join_request",
            type:
              data.type === "rejoin_match_request"
                ? "rejoin_match_request"
                : "join_request",
            pktId: data.pktId,
            roomCode: data.senderRoomCode || ws.guestId,
            guestId: ws.guestId,
            playerName: data.playerName,
            city: data.city,
            hero: data.hero,
          })
        );
      }

      // 3. Host accepts guest & syncs lobby
      else if (
        data.type === "join_accepted" ||
        data.type === "rejoin_active_match" ||
        data.type === "lobby_sync" ||
        data.type === "host_waiting_ready" ||
        data.type === "host_minimized" ||
        data.type === "kicked" ||
        data.type === "room_full" ||
        data.type === "host_in_game"
      ) {
        const room = rooms[ws.roomCode];
        if (room) {
          if (data.members) room.members = data.members;
          if (data.myTeam) room.myTeam = data.myTeam;
          if (data.enemyTeam) room.enemyTeam = data.enemyTeam;
          broadcastToRoomGuests(room, rawStr);
        }
      }

      // 4. Guest adds/removes NPC, picks a hero card, or toggles READY state
      else if (
        data.type === "guest_lobby_update" ||
        data.type === "guest_pick_hero" ||
        data.type === "guest_ready_state" ||
        data.type === "guest_npc_snapshot"
      ) {
        const room = rooms[ws.roomCode || data.roomCode];
        if (room && room.host) {
          sendSafe(room.host, rawStr);
        }
      }

      // 5. Host starts the match / KO / Return to Lobby
      else if (
        data.type === "start_fight" ||
        data.type === "match_ko" ||
        data.type === "return_to_lobby"
      ) {
        const room = rooms[ws.roomCode || data.roomCode];
        if (room) {
          if (ws.isHost) {
            broadcastToRoomGuests(room, rawStr);
          } else if (room.host) {
            sendSafe(room.host, rawStr);
          }
        }
      }

      // 6. 60 FPS BATTLE INPUT QUEUE (Guest -> Host)
      else if (data.type === "player_input") {
        const room = rooms[ws.roomCode || data.roomCode];
        if (room) {
          const gId = data.guestId || ws.guestId;
          if (data.action === "move" && gId && room.gameState.fighters[gId]) {
            room.gameState.fighters[gId].moveLeft = data.moveLeft;
            room.gameState.fighters[gId].moveRight = data.moveRight;
          }
          if (room.host) {
            sendSafe(room.host, rawStr);
          }
        }
      }

      // 7. 60 FPS STATE SYNC (Host -> All Guests via Server Broadcast)
      else if (data.type === "game_state_sync") {
        const room = rooms[ws.roomCode];
        if (room) {
          room.gameState.fighters = data.fighters;
          room.gameState.projectiles = data.projectiles;
          broadcastToRoomGuests(room, rawStr);
          if (ws.isHost && Array.isArray(data.fighters)) {
            const coProc = runCloudCoProcessor(data.fighters, data.projectiles);
            sendSafe(
              ws,
              JSON.stringify({
                type: "cloud_coprocessor_sync",
                seq: data.seq,
                targetMap: coProc.targetMap,
                hits: coProc.hits,
              })
            );
          }
        }
      }
    } catch (e) {
      console.error("Error processing packet:", e);
    }
  });

  ws.on("close", () => {
    if (ws.roomCode && rooms[ws.roomCode]) {
      const room = rooms[ws.roomCode];
      if (ws.isHost) {
        broadcastToRoomGuests(
          room,
          JSON.stringify({ type: "host_disconnected" })
        );
        room.cleanupTimer = setTimeout(() => {
          delete rooms[ws.roomCode];
        }, 600000);

        //  delete rooms[ws.roomCode];
      } else {
        room.guests = room.guests.filter((g) => g !== ws);
        if (room.host) {
          sendSafe(
            room.host,
            JSON.stringify({
              type: "guest_disconnected",
              guestId: ws.guestId,
            })
          );
        }
      }
    }
  });
});

// Keep-alive heartbeat every 25s so Render proxy never drops active connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, 25000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Authoritative 16-Fighter Server listening on port ${PORT}`);
});
