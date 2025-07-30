
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from each app directory
app.use('/passenger-app', express.static(path.join(__dirname, 'passenger-app')));
app.use('/driver-app', express.static(path.join(__dirname, 'driver-app')));
app.use('/tracking-app', express.static(path.join(__dirname, 'tracking-app')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// Route "/" to passenger-app/indexMVP.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'passenger-app', 'indexMVP.html'));
});

// Route "/driver" to driver-app/index.html
app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, 'driver-app', 'index.html'));
});

// Route "/tracking" to tracking-app/index.html
app.get('/tracking', (req, res) => {
  res.sendFile(path.join(__dirname, 'tracking-app', 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
