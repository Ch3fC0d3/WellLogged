const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const router = express.Router();

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// Setup Multer for file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }
})
const upload = multer({ storage: storage });

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

// Create a new log with file upload
router.post('/', requireAuth, upload.single('file'), (req, res) => {
    const { title, well_name, api_number, footage, notes } = req.body;
    
    if (!title) {
        // If they failed validation but uploaded a file, we should remove it
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Title/Project Name is required' });
    }
    
    if (!req.file) {
        return res.status(400).json({ error: 'Source file is required (Image or TIFF)' });
    }

    const source_file_url = '/uploads/' + req.file.filename;

    db.run(`INSERT INTO logs (user_id, title, well_name, api_number, footage, notes, source_file_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, title, well_name, api_number, footage || 0, notes || '', source_file_url],
        function (err) {
            if (err) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(500).json({ error: 'Failed to create log' });
            }
            res.status(201).json({ message: 'Log created', log: { id: this.lastID, title, status: 'uploaded' } });
        }
    );
});

module.exports = router;
