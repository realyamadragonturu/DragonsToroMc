require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Tạo thư mục uploads nếu chưa có
const uploadDir = './public/uploads';
const modsDir = './public/mods';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

// Cấu hình upload ảnh
const storageImage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});

// Cấu hình upload file mod
const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, modsDir),
    filename: (req, file, cb) => {
        const originalName = file.originalname.replace(/\s/g, '_');
        cb(null, Date.now() + '-' + originalName);
    }
});

const uploadImage = multer({ storage: storageImage });
const uploadModFile = multer({ storage: storageFile });

// Database connection
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

app.set('view engine', 'ejs');
app.set('views', './views');

function isAdmin(req, res, next) {
    if (req.session.isAdmin) return next();
    res.redirect('/admin?error=Vui lòng đăng nhập');
}

// Trang chủ
app.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mods ORDER BY id DESC');
        res.render('index', { 
            mods: result.rows, 
            isAdmin: req.session.isAdmin || false 
        });
    } catch (err) {
        console.error(err);
        res.render('index', { mods: [], isAdmin: false });
    }
});

// Admin page
app.get('/admin', (req, res) => {
    res.render('admin', { 
        isAdmin: req.session.isAdmin || false, 
        error: req.query.error || null, 
        success: req.query.success || null 
    });
});

// Đăng nhập
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length > 0 && await bcrypt.compare(password, result.rows[0].password)) {
            req.session.isAdmin = true;
            res.redirect('/admin?success=Đăng nhập thành công');
        } else {
            res.redirect('/admin?error=Sai tài khoản hoặc mật khẩu');
        }
    } catch (err) {
        res.redirect('/admin?error=Lỗi hệ thống');
    }
});

// Thêm mod (hỗ trợ cả link và upload file)
app.post('/admin/add-mod', isAdmin, uploadImage.single('mod_image'), async (req, res) => {
    const { mod_name, mod_description, download_type, download_link } = req.body;
    const imagePath = req.file ? '/uploads/' + req.file.filename : null;

    if (!mod_name || !imagePath || !mod_description) {
        return res.redirect('/admin?error=Vui lòng nhập đầy đủ thông tin và upload ảnh');
    }

    let finalDownloadLink = null;
    let finalDownloadFile = null;

    if (download_type === 'link') {
        if (!download_link) return res.redirect('/admin?error=Vui lòng nhập link tải');
        finalDownloadLink = download_link;
    } else if (download_type === 'file') {
        return res.redirect('/admin?error=Vui lòng upload file mod qua công cụ riêng');
    }

    try {
        await pool.query(
            `INSERT INTO mods (name, description, image, download_type, download_link, download_file) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [mod_name, mod_description, imagePath, download_type, finalDownloadLink, finalDownloadFile]
        );
        res.redirect('/admin?success=Đã thêm mod thành công');
    } catch (err) {
        console.error(err);
        res.redirect('/admin?error=Lỗi khi thêm mod');
    }
});

// API upload file mod riêng (dùng fetch)
app.post('/admin/upload-mod-file', isAdmin, uploadModFile.single('mod_file'), async (req, res) => {
    if (!req.file) return res.json({ error: 'Không có file' });
    res.json({ filename: '/mods/' + req.file.filename });
});

// Xử lý upload file mod kèm theo form
app.post('/admin/add-mod-with-file', isAdmin, uploadImage.single('mod_image'), uploadModFile.single('download_file'), async (req, res) => {
    const { mod_name, mod_description } = req.body;
    const imagePath = req.file ? '/uploads/' + req.file.filename : null;
    const modFilePath = req.files && req.files.download_file ? '/mods/' + req.files.download_file[0].filename : null;

    if (!mod_name || !imagePath || !mod_description || !modFilePath) {
        return res.redirect('/admin?error=Vui lòng nhập đầy đủ thông tin, upload ảnh và file mod');
    }

    try {
        await pool.query(
            `INSERT INTO mods (name, description, image, download_type, download_link, download_file) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [mod_name, mod_description, imagePath, 'file', null, modFilePath]
        );
        res.redirect('/admin?success=Đã thêm mod thành công (file upload)');
    } catch (err) {
        console.error(err);
        res.redirect('/admin?error=Lỗi khi thêm mod');
    }
});

// Tải file mod (khi người dùng bấm Download)
app.get('/download/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mods WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).send('Mod không tồn tại');
        
        const mod = result.rows[0];
        
        if (mod.download_type === 'link') {
            res.redirect(mod.download_link);
        } else if (mod.download_type === 'file' && mod.download_file) {
            const filePath = path.join(__dirname, 'public', mod.download_file);
            if (fs.existsSync(filePath)) {
                res.download(filePath);
            } else {
                res.status(404).send('File không tồn tại trên server');
            }
        } else {
            res.status(404).send('Không tìm thấy file hoặc link');
        }
    } catch (err) {
        res.status(500).send('Lỗi server');
    }
});

// Xóa mod
app.get('/admin/delete/:id', isAdmin, async (req, res) => {
    try {
        const mod = await pool.query('SELECT * FROM mods WHERE id = $1', [req.params.id]);
        if (mod.rows.length > 0) {
            const imagePath = path.join(__dirname, 'public', mod.rows[0].image);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            if (mod.rows[0].download_file) {
                const modPath = path.join(__dirname, 'public', mod.rows[0].download_file);
                if (fs.existsSync(modPath)) fs.unlinkSync(modPath);
            }
        }
        await pool.query('DELETE FROM mods WHERE id = $1', [req.params.id]);
        res.redirect('/?success=Đã xóa mod');
    } catch (err) {
        res.redirect('/?error=Lỗi khi xóa');
    }
});

// Đăng xuất
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
