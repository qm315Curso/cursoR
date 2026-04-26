const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// R executable path — try multiple locations
const R_PATHS = [
  'C:/Program Files/R/R-4.5.3/bin/Rscript.exe',
  'C:/Program Files/R/R-4.5.2/bin/Rscript.exe',
  'C:/Program Files/R/R-4.5.1/bin/Rscript.exe',
  'C:/Program Files/R/R-4.4.0/bin/Rscript.exe',
  'C:/Program Files/R/R-4.3.2/bin/Rscript.exe',
  'Rscript',
];

function findRscript() {
  for (const p of R_PATHS) {
    try {
      if (p === 'Rscript') return p;
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return 'Rscript';
}

const RSCRIPT = findRscript();

// Dirs
const DIRS = ['public', 'saved', 'shared', 'output'];
DIRS.forEach(d => {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'saved')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── REST API ────────────────────────────────────────────────────────────────

// Save code to server
app.post('/api/save', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = safe.endsWith('.R') || safe.endsWith('.Rmd') ? safe : safe + '.R';
  const filepath = path.join(__dirname, 'saved', ext);
  fs.writeFileSync(filepath, content, 'utf8');
  res.json({ success: true, filename: ext });
});

// List saved files
app.get('/api/files', (req, res) => {
  const savedDir = path.join(__dirname, 'saved');
  const files = fs.readdirSync(savedDir)
    .filter(f => f.endsWith('.R') || f.endsWith('.Rmd'))
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(savedDir, f)).size,
      modified: fs.statSync(path.join(savedDir, f)).mtime,
    }))
    .sort((a, b) => b.modified - a.modified);
  res.json(files);
});

// Load a saved file
app.get('/api/files/:name', (req, res) => {
  const filepath = path.join(__dirname, 'saved', path.basename(req.params.name));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  const content = fs.readFileSync(filepath, 'utf8');
  res.json({ content, filename: path.basename(req.params.name) });
});

// Delete a saved file
app.delete('/api/files/:name', (req, res) => {
  const filepath = path.join(__dirname, 'saved', path.basename(req.params.name));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// Upload a file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const content = fs.readFileSync(req.file.path, 'utf8');
  res.json({ content, filename: req.file.originalname });
});

// Share code — generate a unique link
app.post('/api/share', (req, res) => {
  const { content, title, description } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = uuidv4().replace(/-/g, '').slice(0, 12);
  const shared = { id, title: title || 'Untitled', description: description || '', content, created: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'shared', id + '.json'), JSON.stringify(shared), 'utf8');
  res.json({ id, url: `/share/${id}` });
});

// Get shared code
app.get('/api/share/:id', (req, res) => {
  const filepath = path.join(__dirname, 'shared', req.params.id + '.json');
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Shared code not found' });
  const shared = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  res.json(shared);
});

// List recent shared snippets
app.get('/api/shared', (req, res) => {
  const sharedDir = path.join(__dirname, 'shared');
  const items = fs.readdirSync(sharedDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(sharedDir, f), 'utf8'));
      return { id: data.id, title: data.title, description: data.description, created: data.created };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created))
    .slice(0, 50);
  res.json(items);
});

// Share page
app.get('/share/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket — R execution ──────────────────────────────────────────────────

const activeProcesses = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('execute', ({ code, sessionId }) => {
    // Kill any existing process for this session
    if (activeProcesses.has(sessionId)) {
      activeProcesses.get(sessionId).kill();
      activeProcesses.delete(sessionId);
    }

    const outDir = path.join(__dirname, 'output', sessionId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // Remove old PNGs so only the current run's plots are shown
    fs.readdirSync(outDir)
      .filter(f => f.endsWith('.png'))
      .forEach(f => fs.unlinkSync(path.join(outDir, f)));

    const wrappedCode = wrapRCode(code, outDir);
    const tmpFile = path.join(outDir, 'tmp_' + Date.now() + '.R');
    fs.writeFileSync(tmpFile, wrappedCode, 'utf8');

    socket.emit('output', { type: 'start' });

    const proc = spawn(RSCRIPT, ['--vanilla', tmpFile], {
      env: { ...process.env, R_HOME: path.dirname(path.dirname(RSCRIPT)) },
    });

    activeProcesses.set(sessionId, proc);

    proc.stdout.on('data', (data) => {
      socket.emit('output', { type: 'stdout', text: data.toString() });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      // Filter progress messages
      if (!text.match(/^\s*\|/) && !text.match(/^\s*$/)) {
        socket.emit('output', { type: 'stderr', text });
      }
    });

    proc.on('close', (exitCode) => {
      activeProcesses.delete(sessionId);
      try { fs.unlinkSync(tmpFile); } catch (_) {}

      // Collect generated plots in order
      const plots = fs.readdirSync(outDir)
        .filter(f => f.endsWith('.png'))
        .sort()
        .map(f => `/output/${sessionId}/${f}?t=${Date.now()}`);

      socket.emit('output', { type: 'done', exitCode, plots });
    });

    proc.on('error', (err) => {
      socket.emit('output', { type: 'error', text: `Failed to start R: ${err.message}\nPath tried: ${RSCRIPT}` });
    });
  });

  socket.on('kill', ({ sessionId }) => {
    if (activeProcesses.has(sessionId)) {
      activeProcesses.get(sessionId).kill();
      activeProcesses.delete(sessionId);
      socket.emit('output', { type: 'killed' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Wrap R code: open PNG device BEFORE user code so all plots are captured.
// %03d lets R auto-number multiple plots: plot_001.png, plot_002.png, ...
function wrapRCode(code, outDir) {
  const plotPattern = (outDir + '/plot_%03d.png').replace(/\\/g, '/');
  return `
options(warn = 1)

# Open a PNG device — every plot() call writes here automatically
png("${plotPattern}", width = 900, height = 650, res = 96)

tryCatch({
${code}
}, error = function(e) {
  message("Error: ", conditionMessage(e))
})

# Close all open graphics devices to flush files to disk
while (dev.cur() > 1L) tryCatch(dev.off(), error = function(e) NULL)
`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`R Editor running at http://localhost:${PORT}`);
  console.log(`Using Rscript: ${RSCRIPT}`);
});
