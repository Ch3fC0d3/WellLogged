const express = require('express');
const db = require('../db');
const router = express.Router();

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// Get all logs for the logged-in user
router.get('/', requireAuth, (req, res) => {
    db.all(`SELECT * FROM logs WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ logs: rows });
    });
});

// Get a specific log for the logged-in user
router.get('/:id', requireAuth, (req, res) => {
    const logId = req.params.id;
    db.get(`SELECT * FROM logs WHERE id = ? AND user_id = ?`, [logId, req.session.userId], (err, log) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!log) return res.status(404).json({ error: 'Log not found' });
        res.json({ log });
    });
});

// Create a new log (basic implementation)
router.post('/', requireAuth, (req, res) => {
    const { title, well_name, api_number, footage } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    
    db.run(`INSERT INTO logs (user_id, title, well_name, api_number, footage) VALUES (?, ?, ?, ?, ?)`,
        [req.session.userId, title, well_name, api_number, footage],
        function (err) {
            if (err) return res.status(500).json({ error: 'Failed to create log' });
            res.status(201).json({ message: 'Log created', log: { id: this.lastID, title, status: 'uploaded' } });
        }
    );
});

module.exports = router;
