const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.resolve(process.env.SQLITE_DB_PATH || path.join(dataDir, 'database.sqlite'));
console.log(`[db] Using SQLite database at: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        // Initialize tables
        db.serialize(() => {
            // Users table
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    company TEXT,
                    address TEXT,
                    role TEXT DEFAULT 'customer',
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Logs table
            db.run(`
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    well_name TEXT,
                    api_number TEXT,
                    footage INTEGER,
                    num_logs INTEGER DEFAULT 1,
                    curves INTEGER DEFAULT 1,
                    amount_due INTEGER,
                    status TEXT DEFAULT 'uploaded',
                    source_file_url TEXT,
                    source_file_key TEXT,
                    output_file_url TEXT,
                    output_file_key TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Safe migrations for pre-existing databases (ignore errors if column exists)
            db.run(`ALTER TABLE logs ADD COLUMN num_logs INTEGER DEFAULT 1`, () => {});
            db.run(`ALTER TABLE logs ADD COLUMN curves INTEGER DEFAULT 1`, () => {});
            db.run(`ALTER TABLE logs ADD COLUMN source_file_key TEXT`, () => {});
            db.run(`ALTER TABLE logs ADD COLUMN output_file_key TEXT`, () => {});
            db.run(`ALTER TABLE logs ADD COLUMN amount_due INTEGER`, () => {});

            // Invoices table
            db.run(`
                CREATE TABLE IF NOT EXISTS invoices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    stripe_invoice_id TEXT UNIQUE NOT NULL,
                    amount INTEGER,
                    currency TEXT,
                    status TEXT,
                    hosted_invoice_url TEXT,
                    invoice_pdf_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Subscriptions table
            db.run(`
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    stripe_subscription_id TEXT UNIQUE NOT NULL,
                    plan_name TEXT,
                    status TEXT,
                    current_period_end DATETIME,
                    cancel_at_period_end BOOLEAN DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Seed admin user
            const bcrypt = require('bcrypt');
            db.get("SELECT * FROM users WHERE email = 'gabriel@pellegrini.us'", async (err, user) => {
                if (!err && !user) {
                    const password_hash = await bcrypt.hash('RedQueen12', 10);
                    db.run(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`, 
                        ['Gabriel Pellegrini', 'gabriel@pellegrini.us', password_hash, 'admin'], 
                        (err) => {
                            if (!err) console.log("Seeded default admin account.");
                        }
                    );
                }
            });
        });
    }
});

module.exports = db;
