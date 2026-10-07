// ==================================================
// 1. IMPORT PACKAGES
// ==================================================
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const util = require('util');

if (!util.isArray || util.isArray !== Array.isArray) {
    util.isArray = Array.isArray;
}

const flash = require('connect-flash');

const app = express();

// =========================
// Isaac - Workout Statistics
// =========================

function formatDurationDisplay(totalMinutes) {
    const minutes = Number(totalMinutes);

    if (!Number.isFinite(minutes) || minutes <= 0) {
        return '0 min';
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = Math.round(minutes % 60);

    if (hours > 0 && remainingMinutes > 0) {
        return `${hours} h ${remainingMinutes} min`;
    }

    if (hours > 0) {
        return `${hours} h`;
    }

    return `${remainingMinutes} min`;
}

function getWorkoutSummary(workouts) {
    const totalWorkouts = workouts.length;
    const totalDurationMinutes = workouts.reduce((sum, workout) => {
        const duration = Number(workout.duration);
        return sum + (Number.isFinite(duration) ? duration : 0);
    }, 0);

    const totalWeightLifted = workouts.reduce((sum, workout) => {
        const sets = Number(workout.sets);
        const repetitions = Number(workout.repetitions);
        const weight = Number(workout.weight);

        const validSets = Number.isFinite(sets) ? sets : 0;
        const validReps = Number.isFinite(repetitions) ? repetitions : 0;
        const validWeight = Number.isFinite(weight) ? weight : 0;

        return sum + validSets * validReps * validWeight;
    }, 0);

    const heaviestLift = workouts.reduce((max, workout) => {
        const weight = Number(workout.weight);
        return Number.isFinite(weight) ? Math.max(max, weight) : max;
    }, 0);

    return {
        totalWorkouts,
        totalHoursTrainedDisplay: formatDurationDisplay(totalDurationMinutes),
        totalWeightLifted: Number(totalWeightLifted.toFixed(2)),
        averageWorkoutDurationDisplay: formatDurationDisplay(
            totalWorkouts > 0 ? totalDurationMinutes / totalWorkouts : 0
        ),
        heaviestLift: Number(heaviestLift.toFixed(2))
    };
}

// =========================
// Workout Statistics - END
// =========================

// =========================
// Isaac - Personal Best
// =========================

const personalBestFilterScript = `
document.addEventListener('DOMContentLoaded', function () {
    function attachSearchFilter(searchInputId, tableBodyId) {
        const searchBox = document.getElementById(searchInputId);
        const tableBody = document.getElementById(tableBodyId);

        if (!searchBox || !tableBody) {
            return;
        }

        searchBox.addEventListener('input', function () {
            const searchText = searchBox.value.toLowerCase().trim();
            const rows = tableBody.getElementsByTagName('tr');

            for (let i = 0; i < rows.length; i = i + 1) {
                const exerciseName = (rows[i].dataset.exerciseName || rows[i].dataset.exercise || '').toLowerCase();
                rows[i].style.display = exerciseName.includes(searchText) ? '' : 'none';
            }
        });
    }

    attachSearchFilter('pbSearchInput', 'personalBestTableBody');
    attachSearchFilter('workoutHistorySearchInput', 'workoutHistoryTableBody');
    attachSearchFilter('goalsSearchInput', 'goalsTableBody');
});
`;

// =========================
// Personal Best - END
// =========================

// ==================================================
// 2. MYSQL CONNECTION
// ==================================================
const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: true
    }
});

connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }

    console.log('Connected to MySQL database');
});

// Detect goals primary key column name (common variants) and cache it.
let goalsPkName = null;
let goalsPkDetectionPromise = null;

const detectGoalsPk = () => {
    if (goalsPkName) {
        return Promise.resolve(goalsPkName);
    }

    if (goalsPkDetectionPromise) {
        return goalsPkDetectionPromise;
    }

    goalsPkDetectionPromise = new Promise((resolve) => {
        connection.query('SHOW COLUMNS FROM goals', (err, results) => {
            if (err) {
                // Table might not exist yet or user created different schema; fall back to `id`.
                console.warn('Could not inspect `goals` columns:', err && err.message);
                goalsPkName = 'id';
                resolve(goalsPkName);
                return;
            }

            const fields = results.map(r => r.Field.toLowerCase());
            if (fields.includes('id')) goalsPkName = 'id';
            else if (fields.includes('goal_id')) goalsPkName = 'goal_id';
            else if (fields.includes('goals_id')) goalsPkName = 'goals_id';
            else if (fields.includes('goalid')) goalsPkName = 'goalid';
            else if (fields.includes('gid')) goalsPkName = 'gid';
            else goalsPkName = 'id';

            console.log('Detected goals primary key column:', goalsPkName);
            resolve(goalsPkName);
        });
    });

    return goalsPkDetectionPromise;
};

// Run detection once on startup.
detectGoalsPk().catch(() => {});

// ==================================================
// Helper: synchronize goals' achieved flags for a user
// - Computes personal bests from `workouts`, then updates `goals.achieved`
//   so goals reflect current PBs immediately after workout changes.
// ==================================================
function syncGoalsForUser(userId) {
    return new Promise((resolve) => {
        if (!userId) return resolve();

        detectGoalsPk().then((pk) => {
            const pbSql = `
                SELECT exercise_name, MAX(weight) AS best_weight
                FROM workouts
                WHERE user_id = ?
                GROUP BY exercise_name
            `;

            connection.query(pbSql, [userId], (pbErr, pbResults) => {
                if (pbErr) {
                    console.error('Error retrieving personal bests for sync:', pbErr);
                    return resolve();
                }

                const pbMap = {};
                pbResults.forEach(r => {
                    pbMap[r.exercise_name] = r.best_weight ? Number(r.best_weight) : 0;
                });

                const selectSql = `SELECT *, ${pk} AS id FROM goals WHERE user_id = ?`;

                connection.query(selectSql, [userId], (gErr, goals) => {
                    if (gErr) {
                        console.error('Error retrieving goals for sync:', gErr);
                        return resolve();
                    }

                    const updates = [];

                    goals.forEach(goal => {
                        const target = Number(goal.target_weight) || 0;
                        const currentPB = pbMap[goal.exercise_name] || 0;
                        const desiredAchieved = currentPB >= target ? 1 : 0;
                        const actualAchieved = goal.achieved ? 1 : 0;

                        if (desiredAchieved !== actualAchieved) {
                            updates.push(new Promise((res) => {
                                const updateSql = `UPDATE goals SET achieved = ? WHERE ${pk} = ? AND user_id = ?`;
                                connection.query(updateSql, [desiredAchieved, goal[pk] || goal.id, userId], (uErr) => {
                                    if (uErr) console.error('Error updating goal achieved flag during sync:', uErr);
                                    res();
                                });
                            }));
                        }
                    });

                    Promise.all(updates).then(() => resolve()).catch(() => resolve());
                });
            });
        }).catch(() => resolve());
    });
}

// ==================================================
// 3. EXPRESS AND EJS SETUP
// ==================================================

app.set('view engine', 'ejs');

app.use(express.static('public'));

app.use(express.urlencoded({
    extended: false
}));

app.get('/js/personalBest.js', (req, res) => {
    res.type('application/javascript');
    res.send(personalBestFilterScript);
});

// ==================================================
// 4. SESSION SETUP
// ==================================================

app.use(session({
    secret: 'process.env.SESSION_SECRET',
    resave: false,
    saveUninitialized: true,

    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));


// ==================================================
// 5. FLASH MESSAGE SETUP
// ==================================================

app.use(flash());


// ==================================================
// 6. VARIABLES AVAILABLE IN ALL EJS PAGES
// ==================================================

app.use((req, res, next) => {
    res.locals.user = req.session.user;

    res.locals.successMessage =
        req.flash('success');

    res.locals.errorMessage =
        req.flash('error');

    next();
});


// ==================================================
// 7. CHECK WHETHER USER IS LOGGED IN-stan
// ==================================================

const checkAuthenticated = (req, res, next) => {
    if (!req.session.user) {
        req.flash(
            'error',
            'Please log in first.'
        );

        return res.redirect('/login');
    }

    next();
};

//==============================
// Trainer Authentication
//==============================

const checkTrainer = (req, res, next) => {

    if (
        req.session.user &&
        req.session.user.role === 'trainer'
    ) {

        next();

    } else {

        req.flash(
            'error',
            'Access Denied'
        );

        res.redirect('/dashboard');

    }

};

// ==================================================
// 8. REGISTRATION VALIDATION -stan
// ==================================================

const validateRegistration = (req, res, next) => {
    const username = req.body.username;
    const email = req.body.email;
    const password = req.body.password;
    const address = req.body.address;
    const contact = req.body.contact;

    if (
        !username ||
        !email ||
        !password ||
        !address ||
        !contact
    ) {
        req.flash(
            'error',
            'All fields are required.'
        );

        req.flash(
            'formData',
            req.body
        );

        return res.redirect('/register');
    }

    if (password.length < 6) {
        req.flash(
            'error',
            'Password must be at least 6 characters.'
        );

        req.flash(
            'formData',
            req.body
        );

        return res.redirect('/register');
    }

    next();
};


// ==================================================
// 9. WORKOUT VALIDATION-stan
// ==================================================

const validateWorkout = (req, res, next) => {
    const exerciseName =
        req.body.exercise_name;

    const sets =
        req.body.sets;

    const repetitions =
        req.body.repetitions;

    const weight =
        req.body.weight;

    const duration =
        req.body.duration;

    const workoutDate =
        req.body.workout_date;

    let redirectPage = '/addWorkout';

    if (req.params.id) {
        redirectPage =
            '/editWorkout/' + req.params.id;
    }

    if (
        !exerciseName ||
        !sets ||
        !repetitions ||
        weight === '' ||
        !duration ||
        !workoutDate
    ) {
        req.flash(
            'error',
            'All workout fields are required.'
        );

        req.flash(
            'formData',
            req.body
        );

        return res.redirect(redirectPage);
    }

    if (sets <= 0) {
        req.flash(
            'error',
            'Sets must be more than 0.'
        );

        return res.redirect(redirectPage);
    }

    if (repetitions <= 0) {
        req.flash(
            'error',
            'Repetitions must be more than 0.'
        );

        return res.redirect(redirectPage);
    }

    if (weight < 0) {
        req.flash(
            'error',
            'Weight cannot be negative.'
        );

        return res.redirect(redirectPage);
    }

    if (duration <= 0) {
        req.flash(
            'error',
            'Duration must be more than 0.'
        );

        return res.redirect(redirectPage);
    }

    next();
};


// ==================================================
// 9b. GOAL VALIDATION
// ==================================================

const validateGoal = (req, res, next) => {
    const exerciseName = req.body.exercise_name;
    const targetWeight = req.body.target_weight;
    const targetDate = req.body.target_date;

    let redirectPage = '/addGoal';

    if (req.params.id) {
        redirectPage = '/editGoal/' + req.params.id;
    }

    if (!exerciseName || targetWeight === '') {
        req.flash('error', 'Exercise name and target weight are required.');
        req.flash('formData', req.body);
        return res.redirect(redirectPage);
    }

    if (Number(targetWeight) <= 0) {
        req.flash('error', 'Target weight must be greater than 0.');
        return res.redirect(redirectPage);
    }

    next();
};


// ==================================================
// 10. HOME PAGE-stan
// ==================================================

app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/workoutshistory');
    }

    res.render('homepage');
});


// ==================================================
// 11. DISPLAY REGISTRATION PAGE-stan
// ==================================================

app.get('/register', (req, res) => {
    const formData =
        req.flash('formData')[0] || {};

    res.render('register', {
        formData: formData
    });
});


// ==================================================
// 12. PROCESS REGISTRATION -stan
// ==================================================

app.post(
    '/register',
    validateRegistration,
    (req, res) => {
        const username =
            req.body.username;

        const email =
            req.body.email;

        const password =
            req.body.password;

        const address =
            req.body.address;

        const contact =
            req.body.contact;

        const role =
            req.body.role;

        const checkSql = `
            SELECT *
            FROM users
            WHERE email = ?
        `;

        connection.query(
            checkSql,
            [email],
            (error, results) => {
                if (error) {
                    console.error(
                        'Error checking user:',
                        error
                    );

                    req.flash(
                        'error',
                        'Error checking account.'
                    );

                    return res.redirect(
                        '/register'
                    );
                }

                if (results.length > 0) {
                    req.flash(
                        'error',
                        'Email already exists.'
                    );

                    req.flash(
                        'formData',
                        req.body
                    );

                    return res.redirect(
                        '/register'
                    );
                }

                const insertSql = `
                    INSERT INTO users
                    (
                        username,
                        email,
                        password,
                        address,
                        contact_number,
                        role
                    )
                    VALUES (?, ?, SHA2(?,256), ?, ?, ?)
                `;

                const values = [
                    username,
                    email,
                    password,
                    address,
                    contact,
                    role || 'user'
                ];

                connection.query(
                    insertSql,
                    values,
                    (insertError) => {
                        if (insertError) {
                            console.error(
                                'Error registering user:',
                                insertError
                            );

                            req.flash(
                                'error',
                                'Unable to register.'
                            );

                            return res.redirect(
                                '/register'
                            );
                        }

                        req.flash(
                            'success',
                            'Registration successful. Please log in.'
                        );

                        res.redirect('/login');
                    }
                );
            }
        );
    }
);


// ==================================================
// 13. DISPLAY LOGIN PAGE-stan
// ==================================================

app.get('/login', (req, res) => {
    res.render('login');
});


// ==================================================
// 14. PROCESS LOGIN-stan
// ==================================================

app.post('/login', (req, res) => {
    const email = req.body.email;
    const password = req.body.password;

    if (!email || !password) {
        req.flash(
            'error',
            'Email and password are required.'
        );

        return res.redirect('/login');
    }

    const sql = `
        SELECT *
        FROM users
        WHERE email = ?
        AND password = SHA2(?, 256)
    `;

    connection.query(
        sql,
        [email, password],
        (error, results) => {
            if (error) {
                console.error(
                    'Login error:',
                    error
                );

                req.flash(
                    'error',
                    'Unable to log in.'
                );

                return res.redirect('/login');
            }

            if (results.length === 0) {
                req.flash(
                    'error',
                    'Invalid email or password.'
                );

                return res.redirect('/login');
            }

            const user = results[0];

        req.session.user = user;

        // Redirect based on role
        if (user.role === 'trainer') {

            res.redirect('/trainer');

        } else {

            res.redirect('/workoutshistory');

                }
        }
    );
});

// ==================================================
// 15. LOGOUT-stan
// ==================================================

app.get('/logout', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error(
                'Logout error:',
                error
            );

            return res.send(
                'Unable to log out.'
            );
        }

        res.redirect('/login');
    });
});

// ==================================================
// TRAINER DASHBOARD
// ==================================================

app.get(
    '/trainer',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        res.render(
            'trainerDashboard',
            {
                user: req.session.user
            }
        );

    }
);

// ==================================================
// 16. DISPLAY WORKOUT HISTORY-stan
// ==================================================

app.get(
    '/workoutshistory',
    checkAuthenticated,
    (req, res) => {
        const userId =
            req.session.user.id;

        const workoutSql = `
            SELECT *
            FROM workouts
            WHERE user_id = ?
            ORDER BY workout_date DESC,
            workout_id DESC
        `;

// =========================
// Isaac - Personal Best
// =========================

        const personalBestSql = `
            SELECT
                pb.exercise_name,
                pb.best_weight,
                MIN(w.workout_date) AS date_achieved
            FROM workouts w
            INNER JOIN (
                SELECT
                    exercise_name,
                    MAX(weight) AS best_weight
                FROM workouts
                WHERE user_id = ?
                GROUP BY exercise_name
            ) pb ON w.exercise_name = pb.exercise_name
            AND w.weight = pb.best_weight
            WHERE w.user_id = ?
            GROUP BY pb.exercise_name, pb.best_weight
            ORDER BY pb.exercise_name ASC
        `;

        connection.query(
            workoutSql,
            [userId],
            (workoutError, workoutResults) => {
                if (workoutError) {
                    console.error(
                        'Error retrieving workouts:',
                        workoutError
                    );

                    return res.send(
                        'Error retrieving workout history.'
                    );
                }

                connection.query(
                    personalBestSql,
                    [userId, userId],
                    (personalBestError, personalBestResults) => {
                        if (personalBestError) {
                            console.error(
                                'Error retrieving personal best:',
                                personalBestError
                            );

                            return res.send(
                                'Error retrieving workout statistics.'
                            );
                        }

                        const stats = getWorkoutSummary(workoutResults);
                        const pbFlash = req.flash('pbNotification');
                        let pbNotification = null;

                        if (pbFlash && pbFlash.length > 0) {
                            try {
                                pbNotification = JSON.parse(pbFlash[0]);
                            } catch (parseError) {
                                console.error(
                                    'Error parsing PB notification:',
                                    parseError
                                );
                            }
                        }

                        res.render('workoutshistory', {
                            workouts: workoutResults,
                            stats: stats,
                            personalBest: personalBestResults,
                            pbNotification: pbNotification,
                            hasWorkoutData: workoutResults.length > 0
                        });
                    }
                );
            }
        );
    }
);

// =========================
// Personal Best - END
// =========================

// ==================================================
// TRAINER - VIEW ALL WORKOUTS(Bryan)
// ==================================================

app.get(
    '/trainer/workouts',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const sql = `
            SELECT
                workouts.*,
                users.username
            FROM workouts
            INNER JOIN users
            ON workouts.user_id = users.id
            ORDER BY
                workout_date DESC,
                workout_id DESC
        `;

        connection.query(
            sql,
            (error, results) => {

                if (error) {

                    console.error(error);

                    return res.send(
                        "Unable to retrieve workouts."
                    );

                }

                       res.render(
            "trainerWorkouts",
            {
                user: req.session.user,
                workouts: results
            }
);

            }
        );

    }
);

// ==================================================
// TRAINER - DISPLAY EDIT WORKOUT PAGE
// ==================================================

app.get(
    '/trainer/editWorkout/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const workoutId = req.params.id;

        const sql = `
            SELECT
                workouts.*,
                users.username
            FROM workouts
            INNER JOIN users
            ON workouts.user_id = users.id
            WHERE workout_id = ?
        `;

        connection.query(
            sql,
            [workoutId],
            (error, results) => {

                if (error) {

                    console.error(error);

                    return res.send("Database Error");

                }

                if (results.length === 0) {

                    return res.send("Workout not found.");

                }

                res.render(
                    "editTrainerWorkout",
                    {
                        user: req.session.user,
                        workout: results[0]
                    }
                );

            }
        );

    }
);

// ==================================================
// TRAINER - UPDATE WORKOUT
// ==================================================

app.post(
    '/trainer/editWorkout/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const workoutId = req.params.id;

        const {

            exercise_name,
            sets,
            repetitions,
            weight,
            duration,
            workout_date

        } = req.body;

        const sql = `
            UPDATE workouts
            SET
                exercise_name = ?,
                sets = ?,
                repetitions = ?,
                weight = ?,
                duration = ?,
                workout_date = ?
            WHERE workout_id = ?
        `;

        connection.query(
            sql,
            [
                exercise_name,
                sets,
                repetitions,
                weight,
                duration,
                workout_date,
                workoutId
            ],
            (error) => {

                if (error) {

                    console.error(error);

                    return res.send("Unable to update workout.");

                }

               console.log("Flash message set: Workout updated successfully.");

                req.flash(
                    'success',
                    'Workout updated successfully.'
                );

                res.redirect('/trainer/workouts');
                            }
        );

    }
);

// ==================================================
// TRAINER - DELETE WORKOUT
// ==================================================

app.post(
    '/trainer/deleteWorkout/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const workoutId = req.params.id;

        const sql = `
            DELETE FROM workouts
            WHERE workout_id = ?
        `;

        connection.query(
            sql,
            [workoutId],
            (error) => {

                if (error) {

                    console.error(error);

                    return res.send(
                        "Unable to delete workout."
                    );

                }

                req.flash(
                'success',
                'Workout deleted successfully.'
            );

                res.redirect('/trainer/workouts');

            }
        );

    }
);

// ==================================================
// TRAINER - VIEW TRAINEES BODY PROGRESS
// ==================================================

app.get(
    '/trainer/bodyProgress',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const sql = `
            SELECT
                body_progress.*,
                users.username
            FROM body_progress
            INNER JOIN users
            ON body_progress.user_id = users.id
            ORDER BY
                progress_date DESC,
                bp_id DESC
        `;

        connection.query(
            sql,
            (error, results) => {

                if (error) {

                    console.error(error);

                    return res.send(
                        "Unable to retrieve trainee body progress."
                    );

                }

                res.render(
                    "trainerBodyProgress",
                    {
                        user: req.session.user,
                        progress: results
                    }
                );

            }
        );

    }
);

// ==================================================
// TRAINER - DISPLAY EDIT BODY PROGRESS PAGE
// ==================================================

app.get(
    '/trainer/editBodyProgress/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const bpId = req.params.id;

        const sql = `
            SELECT
                body_progress.*,
                users.username
            FROM body_progress
            INNER JOIN users
            ON body_progress.user_id = users.id
            WHERE bp_id = ?
        `;

        connection.query(
            sql,
            [bpId],
            (error, results) => {

                if (error) {

                    console.error(error);

                    return res.send("Database Error");

                }

                if (results.length === 0) {

                    return res.send("Record not found.");

                }

                res.render(
                    "editTrainerBodyProgress",
                    {
                        user: req.session.user,
                        record: results[0]
                    }
                );

            }
        );

    }
);

// ==================================================
// TRAINER - UPDATE BODY PROGRESS RECORD
// ==================================================

app.post(
    '/trainer/editBodyProgress/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const bpId = req.params.id;

        const {

            weight,
            bmi,
            body_fat,
            progress_date

        } = req.body;

        const sql = `
            UPDATE body_progress
            SET
                weight = ?,
                bmi = ?,
                body_fat = ?,
                progress_date = ?
            WHERE bp_id = ?
        `;

        connection.query(
            sql,
            [
                weight,
                bmi,
                body_fat,
                progress_date,
                bpId
            ],
            (error) => {

                if (error) {

                    console.error(error);

                    return res.send("Unable to update record.");

                }

                req.flash(
                    'success',
                    'Body progress record updated successfully.'
                );

                res.redirect('/trainer/bodyProgress');

            }
        );

    }
);

// ==================================================
// TRAINER - DELETE BODY PROGRESS RECORD
// ==================================================

app.post(
    '/trainer/deleteBodyProgress/:id',
    checkAuthenticated,
    checkTrainer,
    (req, res) => {

        const bpId = req.params.id;

        const sql = `
            DELETE FROM body_progress
            WHERE bp_id = ?
        `;

        connection.query(
            sql,
            [bpId],
            (error) => {

                if (error) {

                    console.error(error);

                    return res.send(
                        "Unable to delete body progress record."
                    );

                }

                req.flash(
                    'success',
                    'Body progress record deleted successfully.'
                );

                res.redirect('/trainer/bodyProgress');

            }
        );

    }
);

// ==================================================
// 17. DISPLAY ADD WORKOUT PAGE -stan
// ==================================================

app.get(
    '/addWorkout',
    checkAuthenticated,
    (req, res) => {
        const formData =
            req.flash('formData')[0] || {};

        res.render('addWorkout', {
            formData: formData
        });
    }
);


// ==================================================
// 18. ADD A NEW WORKOUT-stan
// ==================================================

app.post(
    '/addWorkout',
    checkAuthenticated,
    validateWorkout,
    (req, res) => {
        const userId =
            req.session.user.id;

        const exerciseName =
            req.body.exercise_name;

        const sets =
            req.body.sets;

        const repetitions =
            req.body.repetitions;

        const weight =
            Number(req.body.weight);

        const duration =
            req.body.duration;

        const workoutDate =
            req.body.workout_date;

        // =========================
        // Isaac - Personal Best
        // =========================

        const pbSql = `
            SELECT MAX(weight) AS previous_pb
            FROM workouts
            WHERE user_id = ?
            AND exercise_name = ?
        `;

        connection.query(
            pbSql,
            [userId, exerciseName],
            (pbError, pbResults) => {
                if (pbError) {
                    console.error(
                        'Error checking previous PB:',
                        pbError
                    );

                    req.flash(
                        'error',
                        'Unable to add workout.'
                    );

                    req.flash(
                        'formData',
                        req.body
                    );

                    return res.redirect(
                        '/addWorkout'
                    );
                }

                const previousPB =
                    pbResults[0].previous_pb
                        ? Number(pbResults[0].previous_pb)
                        : 0;

                const isNewPB =
                    weight > previousPB;

                const sql = `
                    INSERT INTO workouts
                    (
                        user_id,
                        exercise_name,
                        sets,
                        repetitions,
                        weight,
                        duration,
                        workout_date
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;

                const values = [
                    userId,
                    exerciseName,
                    sets,
                    repetitions,
                    weight,
                    duration,
                    workoutDate
                ];

                connection.query(
                    sql,
                    values,
                    (error) => {
                        if (error) {
                            console.error(
                                'Error adding workout:',
                                error
                            );

                            req.flash(
                                'error',
                                'Unable to add workout.'
                            );

                            req.flash(
                                'formData',
                                req.body
                            );

                            return res.redirect(
                                '/addWorkout'
                            );
                        }

                        if (isNewPB) {
                            const improvementKg = Number((weight - previousPB).toFixed(2));
                            const improvementPct = previousPB > 0
                                ? Number(((improvementKg / previousPB) * 100).toFixed(1))
                                : null;

                            req.flash(
                                'pbNotification',
                                JSON.stringify({
                                    exerciseName,
                                    oldPB: previousPB,
                                    newPB: weight,
                                    improvementKg,
                                    improvementPct,
                                    isNewPB: true
                                })
                            );
                        }

                        // Synchronize goals immediately so achieved flags reflect the
                        // newly added workout's personal bests before redirect.
                        syncGoalsForUser(userId).then(() => {
                            req.flash('success', 'Workout added successfully.');
                            res.redirect('/workoutshistory');
                        }).catch((e) => {
                            console.error('Error syncing goals after addWorkout:', e);
                            req.flash('success', 'Workout added successfully.');
                            res.redirect('/workoutshistory');
                        });
                    }
                );
            }
        );
    }
);

// =========================
// Personal Best - END
// =========================

// ==================================================
// 20. DISPLAY EDIT WORKOUT PAGE-stan
// ==================================================

app.get(
    '/editWorkout/:id',
    checkAuthenticated,
    (req, res) => {
        const workoutId =
            req.params.id;

        const userId =
            req.session.user.id;

        const sql = `
            SELECT *
            FROM workouts 
            WHERE workout_id = ?
            AND user_id = ?
        `;

        connection.query(
            sql,
            [workoutId, userId],
            (error, results) => {
                if (error) {
                    console.error(
                        'Error retrieving workout:',
                        error
                    );

                    return res.send(
                        'Error retrieving workout.'
                    );
                }

                if (results.length === 0) {
                    return res.send(
                        'Workout not found.'
                    );
                }

                res.render(
                    'editWorkout',
                    {
                        workout: results[0]
                    }
                );
            }
        );
    }
);


// ==================================================
// 21. UPDATE WORKOUT-stan
// ==================================================

app.post(
    '/editWorkout/:id',
    checkAuthenticated,
    validateWorkout,
    (req, res) => {
        const workoutId =
            req.params.id;

        const userId =
            req.session.user.id;

        const exerciseName =
            req.body.exercise_name;

        const sets =
            req.body.sets;

        const repetitions =
            req.body.repetitions;

        const weight =
            Number(req.body.weight);

        const duration =
            req.body.duration;

        const workoutDate =
            req.body.workout_date;

        // =========================
        // Isaac - Personal Best (edit handling)
        // - Fetch the current row weight first so we can determine
        //   whether the edited value is a true improvement or a demotion.
        // =========================

        const currentRowSql = `
            SELECT weight
            FROM workouts
            WHERE workout_id = ?
            AND user_id = ?
        `;

        connection.query(
            currentRowSql,
            [workoutId, userId],
            (curErr, curResults) => {
                if (curErr) {
                    console.error('Error fetching current workout:', curErr);

                    req.flash(
                        'error',
                        'Unable to update workout.'
                    );

                    return res.redirect('/editWorkout/' + workoutId);
                }

                if (!curResults || curResults.length === 0) {
                    return res.send('Workout not found.');
                }

                const currentRowWeight = curResults[0].weight
                    ? Number(curResults[0].weight)
                    : 0;

                const pbSql = `
                    SELECT MAX(weight) AS previous_pb
                    FROM workouts
                    WHERE user_id = ?
                    AND exercise_name = ?
                    AND workout_id != ?
                `;

                connection.query(
                    pbSql,
                    [userId, exerciseName, workoutId],
                    (pbError, pbResults) => {
                        if (pbError) {
                            console.error(
                                'Error checking previous PB:',
                                pbError
                            );

                            req.flash(
                                'error',
                                'Unable to update workout.'
                            );

                            return res.redirect(
                                '/editWorkout/' + workoutId
                            );
                        }

                        const previousPBExcludingCurrent =
                            pbResults[0].previous_pb
                                ? Number(pbResults[0].previous_pb)
                                : 0;

                        // The previous personal best for the user/exercise before the edit
                        // should consider the current row's value as well (the value
                        // that will be replaced). Use the larger of the two to represent
                        // the old PB before the update.
                        const previousPBIncludingCurrent = Math.max(previousPBExcludingCurrent, currentRowWeight);

                        const isNewPB = weight > previousPBIncludingCurrent;

                        const sql = `
                            UPDATE workouts
                            SET exercise_name = ?,
                                sets = ?,
                                repetitions = ?,
                                weight = ?,
                                duration = ?,
                                workout_date = ?
                            WHERE workout_id = ?
                            AND user_id = ?
                        `;

                        const values = [
                            exerciseName,
                            sets,
                            repetitions,
                            weight,
                            duration,
                            workoutDate,
                            workoutId,
                            userId
                        ];

                        connection.query(
                            sql,
                            values,
                            (error, results) => {
                                if (error) {
                                    console.error(
                                        'Error updating workout:',
                                        error
                                    );

                                    req.flash(
                                        'error',
                                        'Unable to update workout.'
                                    );

                                    return res.redirect(
                                        '/editWorkout/' + workoutId
                                    );
                                }

                                if (
                                    results.affectedRows === 0
                                ) {
                                    return res.send(
                                        'Workout not found.'
                                    );
                                }

                                if (isNewPB) {
                                    const improvementKg = Number((weight - previousPBIncludingCurrent).toFixed(2));
                                    const improvementPct = previousPBIncludingCurrent > 0
                                        ? Number(((improvementKg / previousPBIncludingCurrent) * 100).toFixed(1))
                                        : null;

                                    req.flash(
                                        'pbNotification',
                                        JSON.stringify({
                                            exerciseName,
                                            oldPB: previousPBIncludingCurrent,
                                            newPB: weight,
                                            improvementKg,
                                            improvementPct,
                                            isNewPB: true
                                        })
                                    );
                                } else {
                                    // Demotion: the current row was previously the PB and the edited
                                    // weight is lower than the previous (current) row's weight.
                                    const wasCurrentRowPB = currentRowWeight >= previousPBExcludingCurrent;
                                    const isLowerThanCurrent = weight < currentRowWeight;

                                    if (wasCurrentRowPB && isLowerThanCurrent) {
                                        const improvementKg = Number((weight - currentRowWeight).toFixed(2));
                                        const improvementPct = currentRowWeight > 0
                                            ? Number(((improvementKg / currentRowWeight) * 100).toFixed(1))
                                            : null;

                                        req.flash(
                                            'pbNotification',
                                            JSON.stringify({
                                                exerciseName,
                                                oldPB: currentRowWeight,
                                                newPB: weight,
                                                improvementKg,
                                                improvementPct,
                                                isNewPB: false,
                                                isDemotion: true
                                            })
                                        );
                                    }
                                }

                                    // Synchronize goals immediately so achieved flags reflect
                                    // the edited workout's personal bests before redirect.
                                    syncGoalsForUser(userId).then(() => {
                                        req.flash('success', 'Workout updated successfully.');
                                        res.redirect('/workoutshistory');
                                    }).catch((e) => {
                                        console.error('Error syncing goals after editWorkout:', e);
                                        req.flash('success', 'Workout updated successfully.');
                                        res.redirect('/workoutshistory');
                                    });
                            }
                        );
                    }
                );
            }
        );
    }
);

// =========================
// Personal Best - END
// =========================

// ==================================================
// 22. DELETE WORKOUT-stan
// ==================================================

app.post(
    '/deleteWorkout/:id',
    checkAuthenticated,
    (req, res) => {
        const workoutId =
            req.params.id;

        const userId =
            req.session.user.id;

        const sql = `
            DELETE FROM workouts
            WHERE workout_id = ?
            AND user_id = ?
        `;

        connection.query(
            sql,
            [workoutId, userId],
            (error, results) => {
                if (error) {
                    console.error(
                        'Error deleting workout:',
                        error
                    );

                    req.flash(
                        'error',
                        'Unable to delete workout.'
                    );

                    return res.redirect(
                        '/workoutshistory'
                    );
                }

                if (
                    results.affectedRows === 0
                ) {
                    return res.send(
                        'Workout not found.'
                    );
                }

                req.flash(
                    'success',
                    'Workout deleted successfully.'
                );

                res.redirect('/workoutshistory');
            }
        );
    }
);


// ==================================================
// 25. GOALS CRUD
// - List, add, create, edit, update, delete
// ==================================================

// =========================
// Isaac - Goals
// =========================

app.get(
    '/goals',
    checkAuthenticated,
    (req, res) => {
        const userId = req.session.user.id;

        detectGoalsPk().then((detectedPk) => {
            // Build SELECT using the detected PK column and alias it to `id`
            // so the views and routes can use a consistent field name.
            let sql;

            if (detectedPk) {
                sql = `SELECT *, ${detectedPk} AS id FROM goals WHERE user_id = ? ORDER BY target_date ASC, id DESC`;
            } else {
                // Fallback if the table does not expose a standard key.
                sql = `SELECT * FROM goals WHERE user_id = ? ORDER BY target_date ASC, target_weight DESC`;
            }

            connection.query(sql, [userId], (error, results) => {
                if (error) {
                    console.error('Error retrieving goals:', error);
                    req.flash('error', 'Unable to load goals.');
                    return res.redirect('/workoutshistory');
                }

                const formData = req.flash('formData')[0] || {};

                // Fetch personal bests from workouts for this user so we can display
                // current PB next to each goal and compute progress.
                const pbSql = `
                    SELECT LOWER(TRIM(exercise_name)) AS exercise_name, MAX(weight) AS best_weight
                    FROM workouts
                    WHERE user_id = ?
                    GROUP BY LOWER(TRIM(exercise_name))
                `;

                connection.query(pbSql, [userId], (pbErr, pbResults) => {
                    if (pbErr) {
                        console.error('Error retrieving personal bests:', pbErr);
                        // Render goals without PB data if PB query fails.
                        // Compute simple summary stats for the goals page.
                        const totalGoals = results.length;
                        const goalsAchieved = results.filter(g => g.achieved).length;
                        const goalsInProgress = totalGoals - goalsAchieved;
                        const completionRate = totalGoals > 0 ? Math.round((goalsAchieved / totalGoals) * 100) : 0;

                        return res.render('goals', {
                            goals: results,
                            formData: formData,
                            goalsSummary: {
                                totalGoals,
                                goalsAchieved,
                                goalsInProgress,
                                completionRate
                            }
                        });
                    }

                    const pbMap = {};
                    pbResults.forEach(row => {
                        const normalizedKey = String(row.exercise_name || '').trim().toLowerCase();
                        pbMap[normalizedKey] = row.best_weight ? Number(row.best_weight) : 0;
                    });

                    // Determine and apply achieved status based on PB vs target.
                    const updates = [];

                    results.forEach(goal => {
                        const target = Number(goal.target_weight) || 0;
                        const normalizedGoalExercise = String(goal.exercise_name || '').trim().toLowerCase();
                        const currentPB = pbMap[normalizedGoalExercise] || 0;
                        goal.currentPB = currentPB;
                        goal.progressPct = target > 0 ? Math.min(100, Math.round((currentPB / target) * 100)) : 0;
                        // Remaining weight to achieve the goal (minimum 0)
                        const remaining = Math.max(0, Number((target - currentPB).toFixed(2)));
                        goal.remaining = remaining;

                        const desiredAchieved = currentPB >= target ? 1 : 0;
                        const actualAchieved = goal.achieved ? 1 : 0;

                        if (desiredAchieved !== actualAchieved) {
                            updates.push(new Promise((resolve) => {
                                const updateSql = `UPDATE goals SET achieved = ? WHERE ${detectedPk} = ? AND user_id = ?`;
                                connection.query(updateSql, [desiredAchieved, goal[detectedPk] || goal.id, userId], (uErr) => {
                                    if (uErr) console.error('Error updating goal achieved flag:', uErr);
                                    // reflect change locally so rendering shows updated value
                                    goal.achieved = desiredAchieved;
                                    resolve();
                                });
                            }));
                        }
                    });

                    Promise.all(updates).then(() => {
                        const totalGoals = results.length;
                        const goalsAchieved = results.filter(g => g.achieved).length;
                        const goalsInProgress = totalGoals - goalsAchieved;
                        const completionRate = totalGoals > 0 ? Math.round((goalsAchieved / totalGoals) * 100) : 0;

                        res.render('goals', {
                            goals: results,
                            formData: formData,
                            goalsSummary: {
                                totalGoals,
                                goalsAchieved,
                                goalsInProgress,
                                completionRate
                            }
                        });
                    }).catch((e) => {
                        console.error('Error applying goal updates:', e);
                        const totalGoals = results.length;
                        const goalsAchieved = results.filter(g => g.achieved).length;
                        const goalsInProgress = totalGoals - goalsAchieved;
                        const completionRate = totalGoals > 0 ? Math.round((goalsAchieved / totalGoals) * 100) : 0;

                        res.render('goals', {
                            goals: results,
                            formData: formData,
                            goalsSummary: {
                                totalGoals,
                                goalsAchieved,
                                goalsInProgress,
                                completionRate
                            }
                        });
                    });
                });
            });
        }).catch(() => {
            req.flash('error', 'Unable to load goals.');
            return res.redirect('/workoutshistory');
        });
    }
);

app.get(
    '/addGoal',
    checkAuthenticated,
    (req, res) => {
        const formData = req.flash('formData')[0] || {};

        res.render('addGoal', {
            formData: formData
        });
    }
);

app.post(
    '/addGoal',
    checkAuthenticated,
    validateGoal,
    (req, res) => {
        const userId = req.session.user.id;
        const exerciseName = req.body.exercise_name;
        const targetWeight = Number(req.body.target_weight);
        const targetDate = req.body.target_date || null;
        const notes = req.body.notes || '';

        const sql = `
            INSERT INTO goals
            (user_id, exercise_name, target_weight, target_date, notes)
            VALUES (?, ?, ?, ?, ?)
        `;

        connection.query(sql, [userId, exerciseName, targetWeight, targetDate, notes], (error) => {
            if (error) {
                console.error('Error adding goal:', error);
                req.flash('error', 'Unable to add goal.');
                req.flash('formData', req.body);
                return res.redirect('/addGoal');
            }

            req.flash('success', 'Goal added successfully.');
            res.redirect('/goals');
        });
    }
);

app.get(
    '/editGoal/:id',
    checkAuthenticated,
    (req, res) => {
        const goalId = req.params.id;
        const userId = req.session.user.id;

        detectGoalsPk().then((pk) => {
            const sql = `SELECT *, ${pk} AS id FROM goals WHERE ${pk} = ? AND user_id = ?`;

            connection.query(sql, [goalId, userId], (error, results) => {
                if (error) {
                    console.error('Error retrieving goal:', error);
                    req.flash('error', 'Unable to retrieve goal.');
                    return res.redirect('/goals');
                }

                if (results.length === 0) {
                    req.flash('error', 'Goal not found.');
                    return res.redirect('/goals');
                }

                res.render('editGoal', { goal: results[0] });
            });
        }).catch(() => {
            req.flash('error', 'Unable to retrieve goal.');
            return res.redirect('/goals');
        });
    }
);

app.post(
    '/editGoal/:id',
    checkAuthenticated,
    validateGoal,
    (req, res) => {
        const goalId = req.params.id;
        const userId = req.session.user.id;

        const exerciseName = req.body.exercise_name;
        const targetWeight = Number(req.body.target_weight);
        const targetDate = req.body.target_date || null;
        const notes = req.body.notes || '';

        detectGoalsPk().then((pk) => {
            // Do not allow manual setting of `achieved` from the edit form. The
            // achieved flag is derived automatically based on personal best vs target.
            const sql = `
                UPDATE goals
                SET exercise_name = ?, target_weight = ?, target_date = ?, notes = ?
                WHERE ${pk} = ? AND user_id = ?
            `;

            connection.query(sql, [exerciseName, targetWeight, targetDate, notes, goalId, userId], (error, results) => {
                if (error) {
                    console.error('Error updating goal:', error);
                    req.flash('error', 'Unable to update goal.');
                    req.flash('formData', req.body);
                    return res.redirect('/editGoal/' + goalId);
                }

                if (results.affectedRows === 0) {
                    req.flash('error', 'Goal not found.');
                    return res.redirect('/goals');
                }

                req.flash('success', 'Goal updated successfully.');
                res.redirect('/goals');
            });
        }).catch(() => {
            req.flash('error', 'Unable to update goal.');
            req.flash('formData', req.body);
            return res.redirect('/editGoal/' + goalId);
        });
    }
);

app.post(
    '/deleteGoal/:id',
    checkAuthenticated,
    (req, res) => {
        const goalId = req.params.id;
        const userId = req.session.user.id;

        detectGoalsPk().then((pk) => {
            const sql = `DELETE FROM goals WHERE ${pk} = ? AND user_id = ?`;

            connection.query(sql, [goalId, userId], (error, results) => {
                if (error) {
                    console.error('Error deleting goal:', error);
                    req.flash('error', 'Unable to delete goal.');
                    return res.redirect('/goals');
                }

                if (results.affectedRows === 0) {
                    req.flash('error', 'Goal not found.');
                    return res.redirect('/goals');
                }

                req.flash('success', 'Goal deleted successfully.');
                res.redirect('/goals');
            });
        }).catch(() => {
            req.flash('error', 'Unable to delete goal.');
            return res.redirect('/goals');
        });
    }
);

// =========================
// Goals - END
// =========================


// =========================
// Body Progress Tracker - Rayyan
// =========================

// Calculator pages - Rayyan
app.get('/BMI', (req, res) => {
    res.render('BMI');
});

app.get('/bodyFat', (req, res) => {
    res.render('bodyFat');
});

// Body Progress Tracker page - Rayyan
app.get("/bodyProgress", checkAuthenticated, (req, res) => {
    const userId = req.session.user.id ?? req.session.user.user_id;

    if (!userId) {
        req.flash('error', 'Please log in first.');
        return res.redirect('/login');
    }

    const sql = `
        SELECT *
        FROM body_progress
        WHERE user_id = ?
        ORDER BY progress_date DESC
    `;

    connection.query(sql, [userId], (err, results) => {
        if (err) {
            console.error('Error retrieving body progress:', err);
            req.flash('error', 'Unable to load body progress.');
            return res.redirect('/workoutshistory');
        }

        res.render("bodyProgress", {
            progress: results || []
        });
    });
});

app.post("/bodyProgress/add", checkAuthenticated, (req, res) => {
    const userId = req.session.user.id ?? req.session.user.user_id;
    const { weight, bmi, body_fat } = req.body;

    if (!userId) {
        req.flash('error', 'Please log in first.');
        return res.redirect('/login');
    }

    const sql = `
        INSERT INTO body_progress(user_id, weight, bmi, body_fat)
        VALUES (?, ?, ?, ?)
    `;

    connection.query(sql, [userId, weight, bmi, body_fat], (err) => {
        if (err) {
            console.error('Error adding body progress record:', err);
            req.flash('error', 'Unable to save body progress record.');
            return res.redirect('/bodyProgress');
        }

        res.redirect("/bodyProgress");
    });
});

// BMI Result page
app.post("/bmiCalculate", checkAuthenticated, (req, res) => {

    const weight = parseFloat(req.body.weight);
    const height = parseFloat(req.body.height);

    const bmi = weight / (height * height);

    res.render("bmiCalculate", {
        weight,
        height,
        bmi: bmi.toFixed(2)
    });

});

// Body Fat Result page
app.post("/bodyFatCalc", checkAuthenticated, (req, res) => {

    const gender = req.body.gender;
    const age = parseInt(req.body.age);

    const weight = parseFloat(req.body.weight);
    const height = parseFloat(req.body.height);

    // Calculate BMI first
    const bmi = weight / (height * height);

    let bodyFat;

    if (gender === "male") {
        bodyFat = (1.20 * bmi) + (0.23 * age) - 16.2;
    } else if (gender === "female") {
        bodyFat = (1.20 * bmi) + (0.23 * age) - 5.4;
    } else {
        bodyFat = null; // Invalid gender
    }

    res.render("bodyFatCalc", {

        gender,
        age,
        weight,
        height,

        bmi: bmi.toFixed(2),
        body_fat: bodyFat.toFixed(2)

    });

});

// =========================
// Body Progress Tracker - END
// =========================


// ==================================================
// 23. PAGE NOT FOUND
// ==================================================

app.use((req, res) => {
    res.send('Page not found.');
});

// ==================================================
// 24. START SERVER
// ==================================================

app.listen(3000, () => {
    console.log(
        'Server started at http://localhost:3000'
    );
});
