// msgboard.js
const express = require('express');
const cors = require('cors');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Set up lowdb JSON store ---
const dbFile = path.join(__dirname, 'db.json');
const adapter = new FileSync(dbFile);
const db = low(adapter);

// Ensure default structure
db.defaults({ messages: [] }).write();

// GET last 50 messages
app.get('/messages', (req, res) => {
  const msgs = db
    .get('messages')
    .sortBy('timestamp')
    .reverse()
    .take(50)
    .value();
  res.json(msgs);
});

// POST a new message
app.post('/messages', (req, res) => {
  const { screenName, message } = req.body;
  const newMsg = {
    id: Date.now(),
    screenName,
    message,
    timestamp: new Date().toISOString(),
  };
  db.get('messages').unshift(newMsg).write();
  res.json({ id: newMsg.id });
});

// Start server
app.listen(port, () => {
  console.log(`Message board server listening at http://localhost:${port}`);
});
