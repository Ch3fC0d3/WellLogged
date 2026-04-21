require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const app = express();

const authRoutes = require('./routes/auth');
const logsRoutes = require('./routes/logs');
const billingRoutes = require('./routes/billing');
const stripeRoutes = require('./routes/stripe');
const adminRoutes = require('./routes/admin');
const db = require('./db');

// Webhook route must be before body-parser because it needs raw body
app.use('/api/stripe', stripeRoutes);

// Body Parsing Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(cors());

// Session Configuration
app.set('trust proxy', 1); // Trust first proxy (required for Railway/Heroku secure cookies)
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_welllogged_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
}));

// Setup API Routes
app.use('/api/auth', authRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);

// Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Protect and serve dashboard routes
app.use('/dashboard', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
