const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
 app.use(express.json());
 app.use(express.urlencoded({ extended: true }));
 app.use('/passenger', express.static(path.join(__dirname, 'passenger-app')));
 app.use('/driver', express.static(path.join(__dirname, 'driver-app')));
 app.use('/tracking', express.static(path.join(__dirname, 'tracking-app')));
 app.use('/shared', express.static(path.join(__dirname, 'shared')));

 // API Routes (for future features)
 app.use('/api', require('./routes/api')); // You'll create this later

 // App Routes
 app.get('/', (req, res) => {
     res.sendFile(path.join(__dirname, 'passenger-app/index.html'));
 });

 app.get('/driver', (req, res) => {
     res.sendFile(path.join(__dirname, 'driver-app/index.html'));
 });

 app.get('/tracking/:tripId?', (req, res) => {
     res.sendFile(path.join(__dirname, 'tracking-app/index.html'));
 });

 // 404 handler
 app.use((req, res) => {
     res.status(404).send('Page not found');
 });

 // Error handler
 app.use((err, req, res, next) => {
     console.error(err.stack);
     res.status(500).send('Something went wrong!');
 });

 app.listen(PORT, () => {
     console.log(`
     🚗 Airport Transfer System is running!
     📱 Passenger App: http://localhost:${PORT}/
     🚘 Driver App: http://localhost:${PORT}/driver
     📍 Tracking App: http://localhost:${PORT}/tracking
     `);
 });

