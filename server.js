const express = require('express');
const { Pool } = require('pg');
const path = require('path');
if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
console.log('DB configured:', dbUrl ? 'yes' : 'NO URL SET');

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
    const datas = ['24 a 26/12', '31/12 a 02/01', '08 a 10/01', '15 a 17/01', '22 a 24/01', '29 a 31/01'];
    const indisponiveis = [];

    // PDF data: columns are períodos 24-26/12, 31/12-02/01, 08-10/01, 15-17/01, 22-24/01, 29-31/01
    // Chácara names in PDF: "Recanto" = Recanto da Videira, "Monte Sião 01" = Monte Sião 1, etc.
    const normalize = (ch) => {
        if (ch.includes('Recanto')) return 'Recanto da Videira';
        if (ch.includes('Monte Sião 01') || ch === 'Monte Sião 1') return 'Monte Sião 1';
        if (ch.includes('Monte Sião 02') || ch === 'Monte Sião 2') return 'Monte Sião 2';
        if (ch.includes('Vinho')) return 'Vinho Novo';
        if (ch.includes('Vinhedo')) return 'Vinhedo';
        return null;
    };

    // Raw preferences from PDF: [nome, [chácaras por período]]
    const rawData = [
        { nome: "Luis Queiroz",                prefs: [["Vinhedo"], [], [], [], [], []] },
        { nome: "Junior Peixoto",               prefs: [["Monte Sião 1","Monte Sião 2"], ["Monte Sião 2","Recanto"], [], ["Monte Sião 1","Monte Sião 2"], [], []] },
        { nome: "Hugo Silva",                   prefs: [["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinho Novo","Vinhedo"], ["Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinhedo"], []] },
        { nome: "Lucas Rodrigues Martins Buzaim", prefs: [["Recanto"], [], [], [], [], []] },
        { nome: "André Araújo Melo",            prefs: [["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinho Novo","Vinhedo"], ["Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinhedo"], ["Vinho Novo","Vinhedo"]] },
        { nome: "Abel Rocha",                   prefs: [["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinho Novo","Vinhedo"], ["Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo"], ["Monte Sião 1","Monte Sião 2"], ["Vinho Novo"]] },
        { nome: "Gabriel Santana",              prefs: [["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2","Vinho Novo"], ["Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], []] },
        { nome: "Marco Aurélio Santana",        prefs: [["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], ["Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], []] },
        { nome: "Marcos Vinícius Mota",         prefs: [["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Vinhedo"], ["Recanto","Vinhedo"], ["Monte Sião 1","Recanto","Vinhedo"], [], []] },
        { nome: "Antonio Batista",              prefs: [["Recanto"], [], [], [], [], []] },
        { nome: "Micael Vogel Carvalhaes",      prefs: [["Monte Sião 1","Monte Sião 2","Vinhedo"], ["Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], [], []] },
        { nome: "Vinicius",                     prefs: [["Recanto"], [], [], ["Monte Sião 1"], [], []] },
        { nome: "Paulo Antônio Cardoso",        prefs: [["Monte Sião 1","Monte Sião 2","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinhedo"], [], [], [], []] },
        { nome: "Jonhy Henrique",               prefs: [["Recanto"], [], [], [], [], []] },
        { nome: "Douglas Almeida",              prefs: [["Recanto"], [], [], [], [], []] },
        { nome: "Gabriel Dias",                 prefs: [["Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinhedo"], ["Vinho Novo","Vinhedo"], [], []] },
        { nome: "Fabio Marin",                  prefs: [["Recanto"], ["Recanto"], [], ["Monte Sião 2"], [], []] },
        { nome: "Arlan Oliveira",               prefs: [["Recanto"], ["Recanto"], ["Recanto"], [], [], []] },
        { nome: "Cleibson Marciano",            prefs: [["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinho Novo","Vinhedo"], ["Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Recanto","Vinho Novo","Vinhedo"], ["Monte Sião 1","Monte Sião 2","Vinhedo"], ["Vinho Novo","Vinhedo"]] },
        { nome: "Ramon José Menezes Dias",      prefs: [["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], ["Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2","Recanto"], ["Monte Sião 1","Monte Sião 2"], []] },
        { nome: "Pr Gustavo Pereira",           prefs: [["Monte Sião 2"], [], ["Monte Sião 2"], [], [], []] },
        { nome: "Aurélio Oponi da Silva Junior", prefs: [["Monte Sião 2","Recanto","Vinho Novo"], ["Monte Sião 1","Monte Sião 2","Recanto"], [], [], [], []] },
        { nome: "Thiago Gonçalves",             prefs: [["Recanto"], [], [], [], [], []] },
    ];

    // Build pastoresData map: nome -> ["Chácara Data", ...]
    const pastoresData = {};
    for (const p of rawData) {
        const slots = [];
        p.prefs.forEach((chs, i) => {
            const data = datas[i];
            for (const ch of chs) {
                const norm = normalize(ch);
                if (norm) slots.push(`${norm} ${data}`);
            }
        });
        pastoresData[p.nome] = slots;
    }

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

app.post('/api/seed/clear-old', async (req, res) => {
    const datasValidas = ['24 a 26/12', '31/12 a 02/01', '08 a 10/01', '15 a 17/01', '22 a 24/01', '29 a 31/01'];
    const placeholders = datasValidas.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(`DELETE FROM preferencias WHERE slot_id IN (SELECT id FROM slots WHERE data NOT IN (${placeholders}))`, datasValidas);
    const result = await pool.query(`DELETE FROM slots WHERE data NOT IN (${placeholders}) RETURNING id`, datasValidas);
    res.json({ ok: true, deleted: result.rowCount });
});

const PORT = process.env.PORT || 3000;

async function start() {
    for (let i = 0; i < 10; i++) {
        try {
            await initDB();
            app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
            return;
        } catch (err) {
            console.log(`DB connection attempt ${i + 1} failed: ${err.message}, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.error('Could not connect to database after 10 attempts');
    process.exit(1);
}

start();
