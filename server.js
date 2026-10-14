
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Legend of Fairy Tail Game Server is Running! 🟢");
});
const wss = new WebSocket.Server({ server });
// Room Store: { [roomCode]: { host: ws,
//  guests: [ws], state: {} } }
const rooms = {};

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.isHost = false;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 1. Host creates / opens a room
      if (data.type === "host_create_room") {
        const code = data.roomCode;
        ws.roomCode = code;
        ws.isHost = true;
        rooms[code] = {
          host: ws,
          guests: [],
          members: data.members || [],
          myTeam: data.myTeam || [],
          enemyTeam: data.enemyTeam || [],
        };
        ws.send(JSON.stringify({ type: "room_created", roomCode: code }));
      }

      // 2. Guest joins a room by 4-digit code
      else if (data.type === "guest_join_request") {
        const code = data.roomCode;
        const room = rooms[code];
        if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Host not online on Room #" + code,
            })
          );
          return;
        }

        ws.roomCode = code;
        ws.isHost = false;
        if (!room.guests.includes(ws)) {
          room.guests.push(ws);
        }

        // Forward join request to host
        room.host.send(
          JSON.stringify({
            type: "join_request",
            playerName: data.playerName,
            city: data.city,
            hero: data.hero,
            guestId:
              data.guestId ||
              "guest_" + Math.random().toString(36).substr(2, 5),
          })
        );
      }

      // 3. Host accepts guest & syncs lobby
      else if (data.type === "join_accepted" || data.type === "lobby_sync") {
        const room = rooms[ws.roomCode];
        if (room) {
          room.members = data.members || room.members;
          room.myTeam = data.myTeam || room.myTeam;
          room.enemyTeam = data.enemyTeam || room.enemyTeam;

          const broadcastMsg = JSON.stringify(data);
          room.guests.forEach((guest) => {
            if (guest.readyState === WebSocket.OPEN) {
              guest.send(broadcastMsg);
            }
          });
        }
      }

      // 4. Guest adds/removes NPC or picks a hero card
      else if (
        data.type === "guest_lobby_update" ||
        data.type === "guest_pick_hero"
      ) {
        const room = rooms[ws.roomCode];
        if (room && room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify(data));
        }
      }

      // 5. Host starts the match
      else if (data.type === "start_fight") {
        const room = rooms[ws.roomCode];
        if (room) {
          const startMsg = JSON.stringify(data);
          room.guests.forEach((guest) => {
            if (guest.readyState === WebSocket.OPEN) {
              guest.send(startMsg);
            }
          });
        }
      }

      // 6. 60 FPS BATTLE INPUT: Guest -> Host (0ms server queue, direct pass)
      else if (data.type === "player_input") {
        const room = rooms[ws.roomCode];
        if (room && room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify(data));
        }
      }

      // 7. 60 FPS STATE SYNC: Host -> All Guests
      else if (data.type === "game_state_sync") {
        const room = rooms[ws.roomCode];
        if (room) {
          const syncMsg = JSON.stringify(data);
          room.guests.forEach((guest) => {
            if (guest.readyState === WebSocket.OPEN) {
              guest.send(syncMsg);
            }
          });
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
        // Notify all guests host disconnected
        room.guests.forEach((g) => {
          if (g.readyState === WebSocket.OPEN) {
            g.send(JSON.stringify({ type: "host_disconnected" }));
          }
        });
        delete rooms[ws.roomCode];
      } else {
        room.guests = room.guests.filter((g) => g !== ws);
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({ type: "guest_disconnected" }));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
          
