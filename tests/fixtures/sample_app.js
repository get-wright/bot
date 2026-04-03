const express = require('express');
const mysql = require('mysql');
const app = express();

app.get('/search', (req, res) => {
    const query = req.query.q;
    res.send('<h1>Results for: ' + query + '</h1>');
});

app.get('/api/search', (req, res) => {
    const query = req.query.q;
    res.json({ results: query });
});

app.get('/users', (req, res) => {
    const id = parseInt(req.query.id);
    const sql = `SELECT * FROM users WHERE id = ${id}`;
    connection.query(sql, (err, results) => {
        res.json(results);
    });
});

function sanitizeInput(input) {
    return input.replace(/[<>&"']/g, '');
}

module.exports = app;
