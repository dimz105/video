const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir) },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.locals.formatNum = (num) => {
    if (!num) return 0;
    return num >= 1000 ? (num / 1000).toFixed(1) + 'K' : num;
};

const dbFile = path.join(__dirname, 'database.json');
// Додано масив users для системи акаунтів
const initDB = { movies: [], stats: { totalViews: 0 }, messages: [], users: [] };
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify(initDB, null, 4));

const readDB = () => {
    let db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if(!db.messages) db.messages = [];
    if(!db.users) db.users = []; // Патч для старих баз
    return db;
};
const writeDB = (data) => fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));

const ADMIN_PASSWORD = '2026';

// Middleware для Адміна
function checkAuth(req, res, next) {
    if (req.cookies.auth_token === 'admin_logged_in') next(); else res.render('admin-login', { title: 'Вхід', error: null });
}

// Middleware для звичайних користувачів (Глобальна змінна user)
app.use((req, res, next) => {
    const db = readDB();
    res.locals.user = null;
    if (req.cookies.user_session) {
        const foundUser = db.users.find(u => u.id === req.cookies.user_session);
        if (foundUser) res.locals.user = foundUser;
    }
    next();
});

function formatYouTubeUrl(url) {
    if (!url) return ""; let videoId = "";
    try {
        if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
        else if (url.includes("youtube.com/watch")) videoId = url.split("v=")[1].split("&")[0];
        else return url; return `https://www.youtube.com/embed/${videoId}?autoplay=1`; 
    } catch (e) { return url; }
}

function getGenresArray(data) {
    if (!data) return []; if (Array.isArray(data)) return data;
    return data.split(',').map(g => g.trim()).filter(Boolean);
}

// === МАРШРУТИ КОРИСТУВАЧІВ (РЕЄСТРАЦІЯ ТА ЛОГІН) ===
app.post('/register', (req, res) => {
    let db = readDB();
    const exists = db.users.find(u => u.username.toLowerCase() === req.body.username.toLowerCase());
    if (exists) return res.redirect('/?error=user_exists');
    
    const newUser = { id: Date.now().toString(), username: req.body.username, password: req.body.password, regDate: new Date().toLocaleDateString('uk-UA') };
    db.users.push(newUser); writeDB(db);
    res.cookie('user_session', newUser.id, { maxAge: 30 * 24 * 60 * 60 * 1000 }); // на 30 днів
    res.redirect('/?success=registered');
});

app.post('/user-login', (req, res) => {
    let db = readDB();
    const user = db.users.find(u => u.username === req.body.username && u.password === req.body.password);
    if (user) {
        res.cookie('user_session', user.id, { maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.redirect('/?success=logged_in');
    } else {
        res.redirect('/?error=wrong_credentials');
    }
});

app.get('/user-logout', (req, res) => {
    res.clearCookie('user_session'); res.redirect('/');
});


// === МАРШРУТИ САЙТУ ===
app.get('/', (req, res) => {
    const db = readDB();
    const searchQuery = req.query.search ? req.query.search.toLowerCase() : '';
    const genreFilter = req.query.genre || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 12; 

    const now = new Date();
    let filteredMovies = db.movies.filter(m => !m.publishDate || new Date(m.publishDate) <= now);

    if (searchQuery) filteredMovies = filteredMovies.filter(m => m.title.toLowerCase().includes(searchQuery) || (m.director && m.director.toLowerCase().includes(searchQuery)) || (m.actors && m.actors.toLowerCase().includes(searchQuery)));
    if (genreFilter) filteredMovies = filteredMovies.filter(m => getGenresArray(m.genre).includes(genreFilter));

    const heroMovies = filteredMovies.filter(m => m.type === 'hero');
    const newsArticles = filteredMovies.filter(m => m.type === 'news');
    const comingSoonMovies = filteredMovies.filter(m => m.type === 'coming_soon');
    const recommendedMovies = filteredMovies.filter(m => m.isRecommendation);
    
    // Перекладено на українську: Фільм, Серіал
    const popularMovies = filteredMovies.filter(m => m.mediaType === 'Фільм' && m.type !== 'news').sort((a, b) => b.rating - a.rating).slice(0, 10);
    const popularSeries = filteredMovies.filter(m => m.mediaType === 'Серіал' && m.type !== 'news').sort((a, b) => b.rating - a.rating).slice(0, 10);

    const regularFeed = filteredMovies.filter(m => m.type !== 'news');
    const topViewed = [...regularFeed].sort((a, b) => (b.views||0) - (a.views||0)).slice(0, 5);

    let allComments = [];
    db.movies.forEach(movie => {
        if(movie.comments) movie.comments.forEach(c => allComments.push({ movieId: movie.id, movieTitle: movie.title, user: c.user, text: c.text, date: c.date, isSpoiler: c.isSpoiler }));
    });

    const startIndex = (page - 1) * limit;
    const paginatedMovies = regularFeed.slice(startIndex, startIndex + limit);
    const totalPages = Math.ceil(regularFeed.length / limit);
    const allGenres = [...new Set(db.movies.filter(m => m.type !== 'news').flatMap(m => getGenresArray(m.genre)))];

    res.render('index', { 
        title: 'Дімз Огляд | Кінобаза України', heroMovies, paginatedMovies, comingSoonMovies, newsArticles, popularMovies, popularSeries, topViewed, recentComments: allComments.slice(0, 5), recommendedMovies, allGenres, searchQuery, genreFilter, currentPage: page, totalPages, fullUrl: req.protocol + '://' + req.get('host') + req.originalUrl
    });
});

app.get('/movie/:id', (req, res) => {
    let db = readDB();
    const movie = db.movies.find(m => m.id == req.params.id);
    if (!movie) return res.status(404).send('Фільм не знайдено');

    let userRatingAvg = 0;
    if(movie.comments && movie.comments.length > 0) {
        const ratedComments = movie.comments.filter(c => c.rating > 0);
        if(ratedComments.length > 0) userRatingAvg = (ratedComments.reduce((acc, c) => acc + c.rating, 0) / ratedComments.length).toFixed(1);
    }
    movie.userRatingAvg = userRatingAvg;
    movie.views = (movie.views || 0) + 1;
    db.stats.totalViews = (db.stats.totalViews || 0) + 1;
    writeDB(db);

    const movieGenres = getGenresArray(movie.genre);
    const similar = db.movies.filter(m => m.id != movie.id && m.type !== 'news' && getGenresArray(m.genre).some(g => movieGenres.includes(g))).slice(0, 4);
    res.render('movie', { title: `${movie.title} - Дімз Огляд`, movie, similar, getGenresArray, fullUrl: req.protocol + '://' + req.get('host') + req.originalUrl });
});

// AJAX КОМЕНТАРІ
app.post('/api/movie/:id/comment', (req, res) => {
    let db = readDB(); const movie = db.movies.find(m => m.id == req.params.id);
    if (movie) {
        // Якщо юзер авторизований, беремо його ім'я з res.locals, інакше з поля або "Анонім"
        const authorName = res.locals.user ? res.locals.user.username : (req.body.username || "Анонім");
        
        const newComment = { 
            id: Date.now(), user: authorName, text: req.body.text, 
            rating: parseInt(req.body.rating) || 0, isSpoiler: req.body.isSpoiler === true,
            date: new Date().toLocaleDateString('uk-UA') 
        };
        if(!movie.comments) movie.comments = [];
        movie.comments.unshift(newComment);
        
        let userRatingAvg = 0;
        const ratedComments = movie.comments.filter(c => c.rating > 0);
        if(ratedComments.length > 0) userRatingAvg = (ratedComments.reduce((acc, c) => acc + c.rating, 0) / ratedComments.length).toFixed(1);
        
        writeDB(db);
        res.json({ success: true, comment: newComment, newAvg: userRatingAvg });
    } else { res.status(404).json({ success: false }); }
});

app.post('/contact', (req, res) => {
    let db = readDB();
    db.messages.unshift({ id: Date.now(), name: req.body.name, title: req.body.title, message: req.body.message, date: new Date().toLocaleDateString('uk-UA') });
    writeDB(db); res.redirect('/?contact=success');
});

// === АДМІНКА ===
app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) { res.cookie('auth_token', 'admin_logged_in', { maxAge: 86400000 }); res.redirect('/admin'); } 
    else res.render('admin-login', { title: 'Вхід', error: 'Невірний пароль!' });
});
app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

app.get('/admin', checkAuth, (req, res) => {
    const db = readDB();
    res.render('admin', { title: 'Управління CMS', movies: db.movies, messages: db.messages || [], totalViews: db.stats.totalViews || 0 });
});

const uploadFields = upload.fields([{ name: 'posterFile', maxCount: 1 }, { name: 'backdropFile', maxCount: 1 }, { name: 'screenshotFiles', maxCount: 5 }]);

app.post('/admin/add', checkAuth, uploadFields, (req, res) => {
    let db = readDB();
    const posterPath = req.files && req.files['posterFile'] ? '/uploads/' + req.files['posterFile'][0].filename : (req.body.posterUrl || '/placeholder-vertical.jpg');
    const backdropPath = req.files && req.files['backdropFile'] ? '/uploads/' + req.files['backdropFile'][0].filename : (req.body.backdropUrl || posterPath);
    let screenshots = [];
    if (req.files && req.files['screenshotFiles']) screenshots = req.files['screenshotFiles'].map(f => '/uploads/' + f.filename);
    if (req.body.screenshotUrls) screenshots = screenshots.concat(req.body.screenshotUrls.split(',').map(u => u.trim()).filter(Boolean));
    const genresArray = req.body.genre ? req.body.genre.split(',').map(g => g.trim()).filter(Boolean) : ['Інше'];

    const newMovie = {
        id: Date.now(), type: req.body.type || 'regular', mediaType: req.body.mediaType || 'Фільм', isRecommendation: req.body.isRecommendation === 'on', 
        publishDate: req.body.publishDate || new Date().toISOString(), 
        title: req.body.title, desc: req.body.desc, genre: genresArray, director: req.body.director || '', actors: req.body.actors || '', year: req.body.year || new Date().getFullYear(),
        poster: posterPath, backdrop: backdropPath, trailer: formatYouTubeUrl(req.body.trailer), screenshots: screenshots,
        netflixUrl: req.body.netflixUrl || '', megogoUrl: req.body.megogoUrl || '', 
        rating: parseFloat(req.body.rating) || 0, date: new Date().toLocaleDateString('uk-UA'), views: 0, likes: 0, comments: []
    };
    db.movies.unshift(newMovie); writeDB(db);
    res.redirect('/admin?success=added');
});

app.post('/admin/edit/:id', checkAuth, uploadFields, (req, res) => {
    let db = readDB(); const index = db.movies.findIndex(m => m.id == req.params.id);
    if(index !== -1) {
        const m = db.movies[index];
        m.title = req.body.title; m.desc = req.body.desc; m.type = req.body.type; m.mediaType = req.body.mediaType; 
        m.director = req.body.director; m.actors = req.body.actors; m.year = req.body.year; m.isRecommendation = req.body.isRecommendation === 'on'; 
        m.publishDate = req.body.publishDate || m.publishDate; m.netflixUrl = req.body.netflixUrl; m.megogoUrl = req.body.megogoUrl;
        m.genre = req.body.genre ? req.body.genre.split(',').map(g => g.trim()).filter(Boolean) : m.genre;
        m.rating = parseFloat(req.body.rating) || m.rating;
        if(req.body.trailer) m.trailer = formatYouTubeUrl(req.body.trailer);
        if(req.files && req.files['posterFile']) m.poster = '/uploads/' + req.files['posterFile'][0].filename; else if(req.body.posterUrl) m.poster = req.body.posterUrl;
        if(req.files && req.files['backdropFile']) m.backdrop = '/uploads/' + req.files['backdropFile'][0].filename; else if(req.body.backdropUrl) m.backdrop = req.body.backdropUrl;
        let newScreenshots = [];
        if (req.files && req.files['screenshotFiles']) newScreenshots = req.files['screenshotFiles'].map(f => '/uploads/' + f.filename);
        if (req.body.screenshotUrls) newScreenshots = newScreenshots.concat(req.body.screenshotUrls.split(',').map(u => u.trim()).filter(Boolean));
        if (newScreenshots.length > 0) m.screenshots = newScreenshots; writeDB(db);
    }
    res.redirect('/admin?success=edited');
});

app.post('/admin/delete/:id', checkAuth, (req, res) => {
    let db = readDB(); db.movies = db.movies.filter(m => m.id != req.params.id); writeDB(db); res.redirect('/admin?success=deleted');
});

app.post('/admin/comment/delete/:movieId/:commentId', checkAuth, (req, res) => {
    let db = readDB(); const movie = db.movies.find(m => m.id == req.params.movieId);
    if(movie && movie.comments) { movie.comments = movie.comments.filter(c => c.id != req.params.commentId); writeDB(db); }
    res.redirect('/admin?success=comment_deleted');
});

app.post('/admin/message/delete/:id', checkAuth, (req, res) => {
    let db = readDB(); db.messages = db.messages.filter(m => m.id != req.params.id); writeDB(db); res.redirect('/admin?success=msg_deleted');
});

app.get('/admin/backup', checkAuth, (req, res) => res.download(dbFile, `backup_${Date.now()}.json`));
app.post('/admin/restore', checkAuth, upload.single('dbfile'), (req, res) => {
    if (req.file) { fs.writeFileSync(dbFile, fs.readFileSync(req.file.path, 'utf8')); fs.unlinkSync(req.file.path); }
    res.redirect('/admin');
});

app.listen(3000, () => console.log(`🚀 Сервер запущено: http://localhost:3000`));