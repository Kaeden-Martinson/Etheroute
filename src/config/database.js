const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database structure
const defaultDB = {
  users: [],
  wallets: [],
  invoices: [],
  transactions: [],
  payouts: [],
  statusIncidents: [],
};

// Load database from JSON file
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return { ...defaultDB };
}

// Save database to JSON file
function saveDatabase(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

// Initialize database on startup
let database = loadDatabase();

// Database operations
const db = {
  // Get all records from a table
  getAll(table) {
    return database[table] || [];
  },

  // Get single record by ID
  getById(table, id) {
    const records = database[table] || [];
    return records.find((record) => record.id === id) || null;
  },

  // Get records by matching criteria
  findBy(table, criteria) {
    const records = database[table] || [];
    return records.filter((record) => {
      for (const [key, value] of Object.entries(criteria)) {
        if (record[key] !== value) return false;
      }
      return true;
    });
  },

  // Get single record matching criteria
  findOneBy(table, criteria) {
    const records = this.findBy(table, criteria);
    return records.length > 0 ? records[0] : null;
  },

  // Create new record
  create(table, data) {
    if (!database[table]) {
      database[table] = [];
    }
    const record = { ...data };
    database[table].push(record);
    saveDatabase(database);
    return record;
  },

  // Update record
  update(table, id, updates) {
    const records = database[table] || [];
    const index = records.findIndex((record) => record.id === id);
    if (index !== -1) {
      database[table][index] = { ...database[table][index], ...updates };
      saveDatabase(database);
      return database[table][index];
    }
    return null;
  },

  // Delete record
  delete(table, id) {
    const records = database[table] || [];
    const index = records.findIndex((record) => record.id === id);
    if (index !== -1) {
      database[table].splice(index, 1);
      saveDatabase(database);
      return true;
    }
    return false;
  },

  // Count records
  count(table) {
    return (database[table] || []).length;
  },

  // Clear all data (useful for testing)
  clear() {
    database = { ...defaultDB };
    saveDatabase(database);
  },
};

module.exports = { db, loadDatabase, saveDatabase };
