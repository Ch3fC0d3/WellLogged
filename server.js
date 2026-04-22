require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
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
app.set('trust proxy', 1); // Trust first proxy
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
    secret: process.env.SESSION_SECRET || 'secret_logdigitizing_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
}));

// Setup API Routes with cache prevention
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.use('/api/auth', authRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);

// Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Protect and serve dashboard routes
app.use('/dashboard', (req, res, next) => {
    // Prevent caching of this route and its redirects to avoid infinite loops
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    if (!req.session.userId) {
        console.log(`[Dashboard Redirect] No user session found. Redirecting to login.`);
        return res.redirect('/login.html');
    }
    
    // Serve dashboard.html for SPA routes starting with /dashboard
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
