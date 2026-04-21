const express = require('express');
const db = require('../db');
const router = express.Router();

const requireAdmin = (req, res, next) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: Admins only' });
    }
    next();
};

// Get all users
router.get('/users', requireAdmin, (req, res) => {
    db.all(`SELECT id, name, email, company, address, role, created_at FROM users ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ users: rows });
    });
});

// Get all logs
router.get('/logs', requireAdmin, (req, res) => {
    db.all(`
        SELECT logs.*, users.email as user_email, users.name as user_name 
        FROM logs 
        JOIN users ON logs.user_id = users.id 
        ORDER BY logs.created_at DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ logs: rows });
    });
});

// Update a log's status and output file
router.patch('/logs/:id', requireAdmin, (req, res) => {
    const logId = req.params.id;
    const { status, output_file_url } = req.body;
    
    db.run(
        `UPDATE logs SET status = COALESCE(?, status), output_file_url = COALESCE(?, output_file_url), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, output_file_url, logId],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ message: 'Log updated successfully' });
        }
    );
});

module.exports = router;
