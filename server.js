const express = require('express');
const { Pool } = require('pg');
const path = require('path');
if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbUrl = process.env.DATABASE_URL;
console.log('Connecting to DB:', dbUrl ? dbUrl.replace(/:[^:@]+@/, ':***@') : 'NO URL SET');
console.log('All DB vars:', Object.keys(process.env).filter(k => k.startsWith('DATABASE')).join(', '));

const pool = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: 10000,
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chacaras (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(100) NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS slots (
            id SERIAL PRIMARY KEY,
            chacara_id INTEGER REFERENCES chacaras(id) ON DELETE CASCADE,
            data VARCHAR(30) NOT NULL,
            disponivel BOOLEAN DEFAULT true,
            UNIQUE(chacara_id, data)
        );

        CREATE TABLE IF NOT EXISTS pastores (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(100) NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS preferencias (
            id SERIAL PRIMARY KEY,
            pastor_id INTEGER REFERENCES pastores(id) ON DELETE CASCADE,
            slot_id INTEGER REFERENCES slots(id) ON DELETE CASCADE,
            UNIQUE(pastor_id, slot_id)
        );

        CREATE TABLE IF NOT EXISTS sorteios (
            id SERIAL PRIMARY KEY,
            realizado_em TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS resultados (
            id SERIAL PRIMARY KEY,
            sorteio_id INTEGER REFERENCES sorteios(id) ON DELETE CASCADE,
            slot_id INTEGER REFERENCES slots(id),
            pastor_id INTEGER REFERENCES pastores(id),
            candidatos TEXT
        );
    `);
}

// === CHACARAS ===
app.get('/api/chacaras', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM chacaras ORDER BY nome');
    res.json(rows);
});

app.post('/api/chacaras', async (req, res) => {
    const { nome } = req.body;
    try {
        const { rows } = await pool.query('INSERT INTO chacaras (nome) VALUES ($1) RETURNING *', [nome]);
        res.json(rows[0]);
    } catch (e) {
        res.status(400).json({ error: 'Chácara já existe' });
    }
});

app.delete('/api/chacaras/:id', async (req, res) => {
    await pool.query('DELETE FROM chacaras WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// === SLOTS ===
app.get('/api/slots', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT s.id, s.data, s.disponivel, c.id as chacara_id, c.nome as chacara_nome
        FROM slots s JOIN chacaras c ON s.chacara_id = c.id
        ORDER BY c.nome, s.data
    `);
    res.json(rows);
});

app.post('/api/slots', async (req, res) => {
    const { chacara_id, data } = req.body;
    try {
        const { rows } = await pool.query(
            'INSERT INTO slots (chacara_id, data) VALUES ($1, $2) RETURNING *',
            [chacara_id, data]
        );
        res.json(rows[0]);
    } catch (e) {
        res.status(400).json({ error: 'Slot já existe' });
    }
});

app.patch('/api/slots/:id', async (req, res) => {
    const { disponivel } = req.body;
    const { rows } = await pool.query(
        'UPDATE slots SET disponivel = $1 WHERE id = $2 RETURNING *',
        [disponivel, req.params.id]
    );
    res.json(rows[0]);
});

app.delete('/api/slots/:id', async (req, res) => {
    await pool.query('DELETE FROM slots WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// === PASTORES ===
app.get('/api/pastores', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT p.*, COALESCE(json_agg(
            json_build_object('slot_id', pr.slot_id, 'chacara', c.nome, 'data', s.data)
        ) FILTER (WHERE pr.slot_id IS NOT NULL), '[]') as preferencias
        FROM pastores p
        LEFT JOIN preferencias pr ON p.id = pr.pastor_id
        LEFT JOIN slots s ON pr.slot_id = s.id
        LEFT JOIN chacaras c ON s.chacara_id = c.id
        GROUP BY p.id ORDER BY p.nome
    `);
    res.json(rows);
});

app.post('/api/pastores', async (req, res) => {
    const { nome } = req.body;
    try {
        const { rows } = await pool.query('INSERT INTO pastores (nome) VALUES ($1) RETURNING *', [nome]);
        res.json(rows[0]);
    } catch (e) {
        res.status(400).json({ error: 'Pastor já existe' });
    }
});

app.delete('/api/pastores/:id', async (req, res) => {
    await pool.query('DELETE FROM pastores WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// === PREFERENCIAS ===
app.post('/api/preferencias', async (req, res) => {
    const { pastor_id, slot_ids } = req.body;
    await pool.query('DELETE FROM preferencias WHERE pastor_id = $1', [pastor_id]);
    for (const slot_id of slot_ids) {
        await pool.query(
            'INSERT INTO preferencias (pastor_id, slot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [pastor_id, slot_id]
        );
    }
    res.json({ ok: true });
});

// === SORTEIO ===
app.post('/api/sortear', async (req, res) => {
    const slotsRes = await pool.query(`
        SELECT s.id, s.data, c.nome as chacara_nome
        FROM slots s JOIN chacaras c ON s.chacara_id = c.id
        WHERE s.disponivel = true
        ORDER BY c.nome, s.data
    `);
    const slots = slotsRes.rows;

    const prefsRes = await pool.query(`
        SELECT pr.slot_id, p.id as pastor_id, p.nome as pastor_nome
        FROM preferencias pr
        JOIN pastores p ON pr.pastor_id = p.id
        JOIN slots s ON pr.slot_id = s.id
        WHERE s.disponivel = true
    `);

    const slotCandidatos = {};
    for (const pref of prefsRes.rows) {
        if (!slotCandidatos[pref.slot_id]) slotCandidatos[pref.slot_id] = [];
        slotCandidatos[pref.slot_id].push({ id: pref.pastor_id, nome: pref.pastor_nome });
    }

    const { rows: [sorteio] } = await pool.query('INSERT INTO sorteios DEFAULT VALUES RETURNING *');

    const won = new Set();
    const resultados = [];

    for (const slot of slots) {
        const candidatos = (slotCandidatos[slot.id] || []).filter(p => !won.has(p.id));
        let winner = null;

        if (candidatos.length > 0) {
            winner = candidatos[Math.floor(Math.random() * candidatos.length)];
            won.add(winner.id);
        }

        await pool.query(
            'INSERT INTO resultados (sorteio_id, slot_id, pastor_id, candidatos) VALUES ($1, $2, $3, $4)',
            [sorteio.id, slot.id, winner?.id || null, candidatos.map(c => c.nome).join(', ')]
        );

        resultados.push({
            slot_id: slot.id,
            chacara: slot.chacara_nome,
            data: slot.data,
            winner: winner?.nome || null,
            winner_id: winner?.id || null,
            candidatos: candidatos.map(c => c.nome)
        });
    }

    res.json({ sorteio_id: sorteio.id, resultados });
});

// === HISTORICO ===
app.get('/api/sorteios', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT s.id, s.realizado_em,
            COUNT(r.pastor_id) as total_sorteados
        FROM sorteios s
        LEFT JOIN resultados r ON s.id = r.sorteio_id AND r.pastor_id IS NOT NULL
        GROUP BY s.id ORDER BY s.realizado_em DESC
    `);
    res.json(rows);
});

app.get('/api/sorteios/:id', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT r.*, s.data, c.nome as chacara_nome, p.nome as pastor_nome
        FROM resultados r
        JOIN slots s ON r.slot_id = s.id
        JOIN chacaras c ON s.chacara_id = c.id
        LEFT JOIN pastores p ON r.pastor_id = p.id
        WHERE r.sorteio_id = $1
        ORDER BY c.nome, s.data
    `, [req.params.id]);
    res.json(rows);
});

app.delete('/api/sorteios/:id', async (req, res) => {
    await pool.query('DELETE FROM resultados WHERE sorteio_id = $1', [req.params.id]);
    await pool.query('DELETE FROM sorteios WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// === SEED ===
app.post('/api/seed', async (req, res) => {
    const chacaras = ['Recanto da Videira', 'Monte Sião 1', 'Monte Sião 2', 'Vinho Novo', 'Vinhedo'];
    const datas = ['03 e 05/07', '10 e 12/07', '17 e 19/07', '24 e 26/07'];
    const indisponiveis = ['Monte Sião 1|03 e 05/07', 'Monte Sião 2|03 e 05/07'];

    const pastoresData = {
        "Luis Queiroz": ["Vinho Novo 24 e 26/07", "Vinhedo 24 e 26/07"],
        "Gabriel Santana": ["Recanto da Videira 10 e 12/07", "Monte Sião 1 10 e 12/07", "Monte Sião 2 10 e 12/07", "Vinho Novo 10 e 12/07", "Vinhedo 10 e 12/07"],
        "Micael Vogel": ["Recanto da Videira 10 e 12/07", "Recanto da Videira 17 e 19/07", "Monte Sião 1 10 e 12/07", "Monte Sião 1 17 e 19/07", "Monte Sião 2 10 e 12/07", "Monte Sião 2 17 e 19/07", "Vinhedo 10 e 12/07", "Vinhedo 17 e 19/07"],
        "Cleibson Marciano": ["Recanto da Videira 03 e 05/07", "Recanto da Videira 10 e 12/07", "Recanto da Videira 17 e 19/07", "Monte Sião 1 10 e 12/07", "Monte Sião 1 17 e 19/07", "Monte Sião 1 24 e 26/07", "Monte Sião 2 10 e 12/07", "Monte Sião 2 17 e 19/07", "Monte Sião 2 24 e 26/07", "Vinho Novo 03 e 05/07", "Vinho Novo 10 e 12/07", "Vinho Novo 17 e 19/07", "Vinho Novo 24 e 26/07", "Vinhedo 03 e 05/07", "Vinhedo 10 e 12/07", "Vinhedo 17 e 19/07", "Vinhedo 24 e 26/07"],
        "Victor Luis": ["Recanto da Videira 10 e 12/07"],
        "Leandro Feliciano": ["Recanto da Videira 10 e 12/07", "Recanto da Videira 17 e 19/07", "Monte Sião 1 10 e 12/07", "Monte Sião 1 17 e 19/07", "Monte Sião 1 24 e 26/07", "Monte Sião 2 10 e 12/07", "Monte Sião 2 17 e 19/07", "Monte Sião 2 24 e 26/07", "Vinho Novo 24 e 26/07", "Vinhedo 24 e 26/07"],
        "Marcos Vinícius": ["Recanto da Videira 10 e 12/07", "Recanto da Videira 17 e 19/07", "Monte Sião 1 10 e 12/07", "Monte Sião 1 17 e 19/07", "Monte Sião 1 24 e 26/07", "Monte Sião 2 10 e 12/07", "Monte Sião 2 17 e 19/07", "Monte Sião 2 24 e 26/07", "Vinhedo 10 e 12/07", "Vinhedo 17 e 19/07", "Vinhedo 24 e 26/07"],
        "Paulo Henrique": ["Recanto da Videira 17 e 19/07"],
        "Vinicius": ["Recanto da Videira 10 e 12/07", "Monte Sião 1 10 e 12/07"],
        "Obr Jonhy Henrique": ["Recanto da Videira 17 e 19/07", "Monte Sião 1 24 e 26/07", "Monte Sião 2 24 e 26/07", "Vinhedo 24 e 26/07"],
        "Djalma Madureira": ["Monte Sião 1 24 e 26/07", "Monte Sião 2 24 e 26/07"],
        "Ramon": ["Recanto da Videira 03 e 05/07", "Recanto da Videira 10 e 12/07", "Recanto da Videira 17 e 19/07", "Monte Sião 1 10 e 12/07", "Monte Sião 2 10 e 12/07", "Monte Sião 2 17 e 19/07"]
    };

    const chacaraIds = {};
    for (const ch of chacaras) {
        const { rows } = await pool.query(
            'INSERT INTO chacaras (nome) VALUES ($1) ON CONFLICT (nome) DO UPDATE SET nome = $1 RETURNING id',
            [ch]
        );
        chacaraIds[ch] = rows[0].id;
    }

    const slotIds = {};
    for (const ch of chacaras) {
        for (const dt of datas) {
            const key = `${ch}|${dt}`;
            const disponivel = !indisponiveis.includes(key);
            const { rows } = await pool.query(
                'INSERT INTO slots (chacara_id, data, disponivel) VALUES ($1, $2, $3) ON CONFLICT (chacara_id, data) DO UPDATE SET disponivel = $3 RETURNING id',
                [chacaraIds[ch], dt, disponivel]
            );
            slotIds[`${ch} ${dt}`] = rows[0].id;
        }
    }

    for (const [nome, prefs] of Object.entries(pastoresData)) {
        const { rows } = await pool.query(
            'INSERT INTO pastores (nome) VALUES ($1) ON CONFLICT (nome) DO UPDATE SET nome = $1 RETURNING id',
            [nome]
        );
        const pastorId = rows[0].id;
        await pool.query('DELETE FROM preferencias WHERE pastor_id = $1', [pastorId]);
        for (const pref of prefs) {
            const slotId = slotIds[pref];
            if (slotId) {
                await pool.query(
                    'INSERT INTO preferencias (pastor_id, slot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [pastorId, slotId]
                );
            }
        }
    }

    res.json({ ok: true, message: 'Dados carregados com sucesso' });
});

const PORT = process.env.PORT || 3000;

async function start() {
    for (let i = 0; i < 5; i++) {
        try {
            await initDB();
            app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
            return;
        } catch (err) {
            console.log(`DB connection attempt ${i + 1} failed: ${err.message}, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.error('Could not connect to database after 5 attempts');
    process.exit(1);
}

start();
