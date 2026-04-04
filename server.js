const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir) },
    filename: function (req, file, cb) { cb(null, 'file-' + Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.locals.formatNum = (num) => num >= 1000 ? (num / 1000).toFixed(1) + 'K' : (num || 0);

app.locals.getBadge = (count) => {
    if (count >= 20) return { name: 'Легенда 👑', color: '#fbbf24' };
    if (count >= 5) return { name: 'Кінокритик 🍿', color: '#8b5cf6' };
    return { name: 'Глядач 🎬', color: '#10b981' };
};

const dbFile = path.join(__dirname, 'database.json');
const initDB = { 
    movies: [], stats: { totalViews: 0 }, messages: [], users: [],
    poll: { question: "Який фільм чекаєте найбільше?", options: [{id:1, text:"Дюна 3", votes:0}, {id:2, text:"Аватар 3", votes:0}], votedUsers: [] }
};
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify(initDB, null, 4));

const readDB = () => {
    let db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if(!db.users) db.users = []; if(!db.poll) db.poll = initDB.poll;
    return db;
};
const writeDB = (data) => fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));

// Єдина система авторизації
app.use((req, res, next) => {
    const db = readDB();
    res.locals.user = null;
    res.locals.isAdmin = false;
    if (req.cookies.user_session) {
        const foundUser = db.users.find(u => u.id === req.cookies.user_session);
        if (foundUser) {
            res.locals.user = foundUser;
            res.locals.isAdmin = foundUser.isAdmin === true;
        }
    }
    next();
});

// Захист Адмінки
function checkAuthAdmin(req, res, next) {
    if (res.locals.isAdmin) {
        next();
    } else {
        if (req.originalUrl.startsWith('/api/')) res.status(403).json({ success: false, error: 'Доступ заборонено. Ви не адміністратор.' });
        else res.redirect('/?error=access_denied');
    }
}

function formatYouTubeUrl(url, autoplayMute = false) {
    if (!url) return ""; let videoId = "";
    try {
        if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
        else if (url.includes("youtube.com/watch")) videoId = url.split("v=")[1].split("&")[0];
        else return url; 
        return autoplayMute ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0` : `https://www.youtube.com/embed/${videoId}?autoplay=1`; 
    } catch (e) { return url; }
}

function getGenresArray(data) { return Array.isArray(data) ? data : (data ? data.split(',').map(g => g.trim()).filter(Boolean) : []); }

// 🇺🇦 ФУНКЦІЯ АВТОПЕРЕКЛАДУ ЧЕРЕЗ GOOGLE TRANSLATE API
async function translateToUk(text) {
    if (!text || text.trim() === '') return '';
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=uk&dt=t&q=${encodeURIComponent(text)}`;
        const response = await axios.get(url);
        return response.data[0].map(item => item[0]).join('');
    } catch (e) { return text; }
}

// === МАРШРУТИ КОРИСТУВАЧІВ ===
app.post('/register', (req, res) => {
    let db = readDB();
    if (db.users.find(u => u.username.toLowerCase() === req.body.username.toLowerCase())) return res.redirect('/?error=user_exists');
    const isFirstUser = db.users.length === 0;
    const newUser = { 
        id: Date.now().toString(), username: req.body.username, email: req.body.email || '', password: req.body.password, 
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${req.body.username}`, isAdmin: isFirstUser, commentsCount: 0, regDate: new Date().toLocaleDateString('uk-UA') 
    };
    db.users.push(newUser); writeDB(db);
    res.cookie('user_session', newUser.id, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/?success=registered');
});

app.post('/user-login', (req, res) => {
    let db = readDB();
    const user = db.users.find(u => u.username === req.body.username && u.password === req.body.password);
    if (user) { res.cookie('user_session', user.id, { maxAge: 30 * 24 * 60 * 60 * 1000 }); res.redirect('/?success=logged_in'); } 
    else res.redirect('/?error=wrong_credentials');
});
app.get('/user-logout', (req, res) => { res.clearCookie('user_session'); res.redirect('/'); });

app.get('/profile', (req, res) => {
    if (!res.locals.user) return res.redirect('/');
    res.render('profile', { title: 'Мій Профіль | Дімз Огляд' });
});
app.post('/profile/update', upload.single('avatarFile'), (req, res) => {
    if (!res.locals.user) return res.redirect('/');
    let db = readDB(); const uIndex = db.users.findIndex(u => u.id === res.locals.user.id);
    if (uIndex !== -1) {
        if(req.body.email) db.users[uIndex].email = req.body.email;
        if(req.body.password) db.users[uIndex].password = req.body.password;
        if(req.file) db.users[uIndex].avatar = '/uploads/' + req.file.filename;
        writeDB(db); res.redirect('/profile?success=updated');
    } else res.redirect('/');
});

// === МАРШРУТИ САЙТУ ===
app.get('/', (req, res) => {
    const db = readDB();
    const searchQuery = req.query.search ? req.query.search.toLowerCase() : '';
    const genreFilter = req.query.genre || '';
    const page = parseInt(req.query.page) || 1; const limit = 12; 

    const now = new Date(); let filteredMovies = db.movies.filter(m => !m.publishDate || new Date(m.publishDate) <= now);
    if (searchQuery) filteredMovies = filteredMovies.filter(m => m.title.toLowerCase().includes(searchQuery) || (m.director && m.director.toLowerCase().includes(searchQuery)));
    if (genreFilter) filteredMovies = filteredMovies.filter(m => getGenresArray(m.genre).includes(genreFilter));

    const heroMovies = filteredMovies.filter(m => m.type === 'hero');
    const newsArticles = filteredMovies.filter(m => m.type === 'news');
    const comingSoonMovies = filteredMovies.filter(m => m.type === 'coming_soon');
    const recommendedMovies = filteredMovies.filter(m => m.isRecommendation);
    const popularMovies = filteredMovies.filter(m => m.mediaType === 'Фільм' && m.type !== 'news').sort((a, b) => b.rating - a.rating).slice(0, 10);
    const popularSeries = filteredMovies.filter(m => m.mediaType === 'Серіал' && m.type !== 'news').sort((a, b) => b.rating - a.rating).slice(0, 10);
    const regularFeed = filteredMovies.filter(m => m.type !== 'news');
    const topViewed = [...regularFeed].sort((a, b) => (b.views||0) - (a.views||0)).slice(0, 5);

    let allComments = []; db.movies.forEach(m => { if(m.comments) m.comments.forEach(c => allComments.push({ movieId: m.id, movieTitle: m.title, ...c })); });
    const startIndex = (page - 1) * limit; const paginatedMovies = regularFeed.slice(startIndex, startIndex + limit); const totalPages = Math.ceil(regularFeed.length / limit);
    if(req.query.json) return res.json({ movies: paginatedMovies, totalPages });

    const allGenres = [...new Set(db.movies.filter(m => m.type !== 'news').flatMap(m => getGenresArray(m.genre)))];
    const hasVoted = res.locals.user ? db.poll.votedUsers.includes(res.locals.user.id) : false;

    res.render('index', { title: 'Дімз Огляд | Кінобаза України', heroMovies, paginatedMovies, comingSoonMovies, newsArticles, popularMovies, popularSeries, topViewed, recentComments: allComments.sort((a,b)=>b.id-a.id).slice(0, 5), recommendedMovies, allGenres, searchQuery, genreFilter, currentPage: page, totalPages, poll: db.poll, hasVoted, fullUrl: req.protocol + '://' + req.get('host') + req.originalUrl });
});

app.get('/movie/:id', (req, res) => {
    let db = readDB(); const movie = db.movies.find(m => m.id == req.params.id);
    if (!movie) return res.status(404).send('Фільм не знайдено');

    let userRatingAvg = 0; let ratingCounts = { '10': 0, '8': 0, '6': 0, '4': 0, '2': 0 }; let totalRatings = 0;
    if(movie.comments && movie.comments.length > 0) {
        const ratedComments = movie.comments.filter(c => c.rating > 0);
        if(ratedComments.length > 0) {
            userRatingAvg = (ratedComments.reduce((acc, c) => acc + c.rating, 0) / ratedComments.length).toFixed(1);
            ratedComments.forEach(c => { if(ratingCounts[c.rating] !== undefined) ratingCounts[c.rating]++; totalRatings++; });
        }
    }
    movie.userRatingAvg = userRatingAvg; movie.ratingCounts = ratingCounts; movie.totalRatings = totalRatings;
    movie.views = (movie.views || 0) + 1; db.stats.totalViews = (db.stats.totalViews || 0) + 1; writeDB(db);

    const movieGenres = getGenresArray(movie.genre);
    const similar = db.movies.filter(m => m.id != movie.id && m.type !== 'news' && getGenresArray(m.genre).some(g => movieGenres.includes(g))).slice(0, 4);
    res.render('movie', { title: `${movie.title} - Дімз Огляд`, movie, similar, getGenresArray, fullUrl: req.protocol + '://' + req.get('host') + req.originalUrl });
});

app.post('/api/movie/:id/comment', (req, res) => {
    let db = readDB(); const movie = db.movies.find(m => m.id == req.params.id);
    if (movie) {
        const authorName = res.locals.user ? res.locals.user.username : (req.body.username || "Анонім");
        const authorAvatar = res.locals.user ? res.locals.user.avatar : `https://api.dicebear.com/7.x/avataaars/svg?seed=${authorName}`;
        let userCommentsCount = 0;
        if(res.locals.user) { const uIndex = db.users.findIndex(u => u.id === res.locals.user.id); if(uIndex !== -1) { db.users[uIndex].commentsCount = (db.users[uIndex].commentsCount || 0) + 1; userCommentsCount = db.users[uIndex].commentsCount; } }

        const newComment = { id: Date.now(), user: authorName, avatar: authorAvatar, text: req.body.text, rating: parseInt(req.body.rating) || 0, isSpoiler: req.body.isSpoiler === true, date: new Date().toLocaleDateString('uk-UA'), likes: 0, userCommentsCount };
        if(!movie.comments) movie.comments = []; movie.comments.unshift(newComment); writeDB(db);
        res.json({ success: true, comment: newComment, badge: app.locals.getBadge(userCommentsCount) });
    } else { res.status(404).json({ success: false }); }
});

app.post('/api/comment/:movieId/:commentId/like', (req, res) => {
    let db = readDB(); const movie = db.movies.find(m => m.id == req.params.movieId);
    if (movie && movie.comments) { const comment = movie.comments.find(c => c.id == req.params.commentId); if(comment) { comment.likes = (comment.likes || 0) + 1; writeDB(db); return res.json({ success: true, likes: comment.likes }); } }
    res.json({ success: false });
});

app.post('/api/poll/vote', (req, res) => {
    if(!res.locals.user) return res.status(401).json({error: 'auth'}); let db = readDB();
    if(db.poll.votedUsers.includes(res.locals.user.id)) return res.json({error: 'already_voted'});
    const option = db.poll.options.find(o => o.id == req.body.optionId);
    if(option) { option.votes++; db.poll.votedUsers.push(res.locals.user.id); writeDB(db); res.json({success: true, poll: db.poll}); } else res.json({success: false});
});

app.post('/contact', (req, res) => { let db = readDB(); db.messages.unshift({ id: Date.now(), name: req.body.name, title: req.body.title, message: req.body.message, date: new Date().toLocaleDateString('uk-UA') }); writeDB(db); res.redirect('/?contact=success'); });

// ========================================================================
// 🚀 МЕГА-ПАРСЕР (З ВІДФІЛЬТРОВУВАННЯМ ПОСТЕРА З КАДРІВ)
// ========================================================================
app.post('/api/parse', checkAuthAdmin, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.json({ success: false, error: 'Посилання не вказано' });

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en-US;q=0.7,en;q=0.6',
                'Cache-Control': 'no-cache'
            },
            timeout: 10000 
        });
        
        let html = '';
        const bufferString = response.data.toString('utf-8').substring(0, 2000).toLowerCase();
        if (bufferString.includes('charset=windows-1251') || url.includes('filmix')) {
            html = new TextDecoder('windows-1251').decode(response.data);
        } else {
            html = new TextDecoder('utf-8').decode(response.data);
        }

        const $ = cheerio.load(html);
        const data = { title: '', year: '', director: '', actors: '', genre: '', desc: '', poster: '', mediaType: 'Фільм', seasons: '', screenshots: '' };
        
        let rawTitle = $('h1[itemprop="name"]').text().trim() || $('h1.name').text().trim() || $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
        data.title = rawTitle.replace(/дивитись онлайн.*/i, '').replace(/смотреть онлайн.*/i, '').split('/')[0].split('|')[0].replace(/\(\d{4}\)/g, '').trim();

        let posterSrc = $('.film-poster img').attr('src') || $('.poster img').attr('src') || $('.m-img img').attr('src') || $('meta[property="og:image"]').attr('content');
        if (posterSrc) {
            if (posterSrc.startsWith('//')) posterSrc = 'https:' + posterSrc;
            else if (posterSrc.startsWith('/')) posterSrc = new URL(url).origin + posterSrc;
            data.poster = posterSrc;
        }

        $('.item, .fi-item, .info-list li, .film-info-list li').each((i, el) => {
            const labelHtml = $(el).find('.label, .fi-label, strong, b').first().text().toLowerCase().trim() || '';
            const rawText = $(el).text().replace(/\s+/g, ' ').toLowerCase();
            
            let valTags = $(el).find('.item-content a, .fi-desc a, a').map((i, a) => $(a).text().trim()).get().join(', ');
            let valText = $(el).find('.item-content, .fi-desc').text().trim() || $(el).text().replace(/^[^:]+:/, '').trim();
            let finalValue = valTags || valText;

            if (labelHtml.includes('рік') || labelHtml.includes('год') || rawText.includes('рік виходу') || rawText.includes('год:')) {
                const yMatch = rawText.match(/\b(19|20)\d{2}\b/);
                if(yMatch) data.year = yMatch[0];
            }
            else if (labelHtml.includes('режисер') || labelHtml.includes('режиссёр') || labelHtml.includes('режиссер') || rawText.includes('режисер:')) {
                if(finalValue) data.director = finalValue;
            }
            else if (labelHtml.includes('актор') || labelHtml.includes('ролях') || rawText.includes('в ролях:')) {
                if(finalValue) data.actors = finalValue;
            }
            else if (labelHtml.includes('жанр')) {
                if(finalValue) data.genre = finalValue;
            }
        });

        let desc = $('.full-text').text().trim(); 
        if (!desc) {
            let $story = $('.full-story').clone();
            $story.find('.info, .full-panel, .post-video, .item, .title, .frames').remove(); 
            desc = $story.text().trim();
        }
        if(!desc) desc = $('div[itemprop="description"]').text().trim() || $('.fdesc').first().text().trim();
        desc = desc.replace(/Про що фільм.*?[:]/i, '').replace(/Про що серіал.*?[:]/i, '').trim();
        data.desc = desc;

        // 📸 ПАРСИНГ СКРІНШОТІВ З ВИДАЛЕННЯМ ПОСТЕРА
        let screenshotsArr = [];
        $('.frames-list a, .gallery a, .screen-list a, .fancybox').each((i, el) => {
            let href = $(el).attr('href') || $(el).attr('data-src');
            if(href && href.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
                if (href.startsWith('//')) href = 'https:' + href;
                else if (href.startsWith('/')) href = new URL(url).origin + href;
                screenshotsArr.push(href);
            }
        });
        if (screenshotsArr.length === 0) {
            $('.frames-list img, .gallery img, .screen-list img').each((i, el) => {
                let src = $(el).attr('src') || $(el).attr('data-src');
                if (src) {
                    if (src.startsWith('//')) src = 'https:' + src;
                    else if (src.startsWith('/')) src = new URL(url).origin + src;
                    screenshotsArr.push(src);
                }
            });
        }
        
        if (screenshotsArr.length > 0) {
            // ✅ ФІЛЬТРУЄМО, ЩОБ ПОСТЕР НЕ ПОТРАПЛЯВ ДО КАДРІВ
            const uniqueScreenshots = [...new Set(screenshotsArr)].filter(src => src !== data.poster);
            data.screenshots = uniqueScreenshots.slice(0, 5).join(', ');
        }

        const fullTitleStr = ($('h1').text() + ' ' + $('title').text()).toLowerCase();
        const seasonMatch = fullTitleStr.match(/(\d+)\s*(?:сезон|сезони|сезонів)/i);
        if (seasonMatch || fullTitleStr.includes('серіал') || $('.season-list, .episodes').length > 0 || url.includes('series')) {
            data.mediaType = 'Серіал';
            if (seasonMatch) data.seasons = seasonMatch[1];
        }

        if (data.title) data.title = await translateToUk(data.title);
        if (data.genre) data.genre = await translateToUk(data.genre);
        if (data.director) data.director = await translateToUk(data.director);
        if (data.actors) data.actors = await translateToUk(data.actors);
        if (data.desc) data.desc = await translateToUk(data.desc);

        if (data.title) {
            const cleanTitle = data.title.replace(/[\(\)\[\]]/g, '').trim();
            const encodedTitle = encodeURIComponent(cleanTitle);
            data.netflixUrl = `https://www.netflix.com/search?q=${encodedTitle}`;
            data.megogoUrl = `https://megogo.net/ua/search?q=${encodedTitle}`;
        }

        res.json({ success: true, data });

    } catch (error) {
        console.error('Помилка парсингу:', error.message);
        let errorMsg = 'Не вдалося розпарсити сторінку.';
        if (error.response) {
            if (error.response.status === 403 || error.response.status === 503) errorMsg = `Сайт (${error.response.status}) заблокував запит.`;
            else if (error.response.status === 404) errorMsg = `Сторінка не знайдена (Помилка 404).`;
            else errorMsg = `Сервер сайту відхилив запит (Код: ${error.response.status}).`;
        } else if (error.code === 'ECONNABORTED') errorMsg = `Сайт не відповідає занадто довго (Таймаут).`;

        res.status(500).json({ success: false, error: errorMsg });
    }
});
// ========================================================================

app.get('/admin', checkAuthAdmin, (req, res) => {
    const db = readDB(); res.render('admin', { title: 'Управління CMS', movies: db.movies, messages: db.messages || [], users: db.users || [], poll: db.poll, totalViews: db.stats.totalViews || 0 });
});

const uploadFields = upload.fields([{ name: 'posterFile', maxCount: 1 }, { name: 'backdropFile', maxCount: 1 }, { name: 'screenshotFiles', maxCount: 5 }]);

app.post('/admin/add', checkAuthAdmin, uploadFields, (req, res) => {
    let db = readDB();
    const posterPath = req.files && req.files['posterFile'] ? '/uploads/' + req.files['posterFile'][0].filename : (req.body.posterUrl || '/placeholder-vertical.jpg');
    const backdropPath = req.files && req.files['backdropFile'] ? '/uploads/' + req.files['backdropFile'][0].filename : (req.body.backdropUrl || posterPath);
    let screenshots = [];
    if (req.files && req.files['screenshotFiles']) screenshots = req.files['screenshotFiles'].map(f => '/uploads/' + f.filename);
    if (req.body.screenshotUrls) screenshots = screenshots.concat(req.body.screenshotUrls.split(',').map(u => u.trim()).filter(Boolean));

    const newMovie = {
        id: Date.now(), type: req.body.type || 'regular', mediaType: req.body.mediaType || 'Фільм', isRecommendation: req.body.isRecommendation === 'on', 
        publishDate: req.body.publishDate || new Date().toISOString(), title: req.body.title, desc: req.body.desc, trivia: req.body.trivia || '', 
        genre: getGenresArray(req.body.genre), director: req.body.director || '', actors: req.body.actors || '', year: req.body.year || new Date().getFullYear(),
        seasons: req.body.seasons || '', 
        poster: posterPath, backdrop: backdropPath, trailer: formatYouTubeUrl(req.body.trailer), hoverTrailer: formatYouTubeUrl(req.body.trailer, true),
        screenshots: screenshots, netflixUrl: req.body.netflixUrl || '', megogoUrl: req.body.megogoUrl || '', 
        rating: parseFloat(req.body.rating) || 0, date: new Date().toLocaleDateString('uk-UA'), views: 0, likes: 0, comments: []
    };
    db.movies.unshift(newMovie); writeDB(db); res.redirect('/admin?success=added');
});

app.post('/admin/edit/:id', checkAuthAdmin, uploadFields, (req, res) => {
    let db = readDB(); const index = db.movies.findIndex(m => m.id == req.params.id);
    if(index !== -1) {
        const m = db.movies[index];
        m.title = req.body.title; m.desc = req.body.desc; m.trivia = req.body.trivia || ''; m.type = req.body.type; m.mediaType = req.body.mediaType; 
        m.director = req.body.director; m.actors = req.body.actors; m.year = req.body.year; m.seasons = req.body.seasons || '';
        m.isRecommendation = req.body.isRecommendation === 'on'; m.publishDate = req.body.publishDate || m.publishDate; 
        m.netflixUrl = req.body.netflixUrl; m.megogoUrl = req.body.megogoUrl; m.genre = getGenresArray(req.body.genre); m.rating = parseFloat(req.body.rating) || m.rating;
        if(req.body.trailer) { m.trailer = formatYouTubeUrl(req.body.trailer); m.hoverTrailer = formatYouTubeUrl(req.body.trailer, true); }
        if(req.files && req.files['posterFile']) m.poster = '/uploads/' + req.files['posterFile'][0].filename; else if(req.body.posterUrl) m.poster = req.body.posterUrl;
        if(req.files && req.files['backdropFile']) m.backdrop = '/uploads/' + req.files['backdropFile'][0].filename; else if(req.body.backdropUrl) m.backdrop = req.body.backdropUrl;
        let newScreenshots = [];
        if (req.files && req.files['screenshotFiles']) newScreenshots = req.files['screenshotFiles'].map(f => '/uploads/' + f.filename);
        if (req.body.screenshotUrls) newScreenshots = newScreenshots.concat(req.body.screenshotUrls.split(',').map(u => u.trim()).filter(Boolean));
        if (newScreenshots.length > 0) m.screenshots = newScreenshots; writeDB(db);
    }
    res.redirect('/admin?success=edited');
});

app.post('/admin/delete/:id', checkAuthAdmin, (req, res) => { let db = readDB(); db.movies = db.movies.filter(m => m.id != req.params.id); writeDB(db); res.redirect('/admin?success=deleted'); });
app.post('/admin/comment/delete/:movieId/:commentId', checkAuthAdmin, (req, res) => { let db = readDB(); const movie = db.movies.find(m => m.id == req.params.movieId); if(movie && movie.comments) { movie.comments = movie.comments.filter(c => c.id != req.params.commentId); writeDB(db); } res.redirect('/admin?success=comment_deleted'); });
app.post('/admin/message/delete/:id', checkAuthAdmin, (req, res) => { let db = readDB(); db.messages = db.messages.filter(m => m.id != req.params.id); writeDB(db); res.redirect('/admin?success=msg_deleted'); });
app.post('/admin/user/delete/:id', checkAuthAdmin, (req, res) => { let db = readDB(); db.users = db.users.filter(u => u.id != req.params.id); writeDB(db); res.redirect('/admin?success=user_deleted'); });

app.post('/admin/poll/update', checkAuthAdmin, (req, res) => {
    let db = readDB();
    db.poll = { question: req.body.question, options: [ {id:1, text: req.body.opt1, votes:0}, {id:2, text: req.body.opt2, votes:0} ], votedUsers: [] };
    if(req.body.opt3) db.poll.options.push({id:3, text: req.body.opt3, votes:0});
    writeDB(db); res.redirect('/admin?success=poll_updated');
});

app.get('/admin/backup', checkAuthAdmin, (req, res) => res.download(dbFile, `backup_${Date.now()}.json`));
app.post('/admin/restore', checkAuthAdmin, upload.single('dbfile'), (req, res) => { if (req.file) { fs.writeFileSync(dbFile, fs.readFileSync(req.file.path, 'utf8')); fs.unlinkSync(req.file.path); } res.redirect('/admin'); });

app.listen(3000, () => console.log(`🚀 Сервер запущено: http://localhost:3000`));