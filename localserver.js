/*
 * localserver.js - offline stand-in for the original Cube (playmapscube.com) backend.
 *
 * The 2012 game talks to a Google App Engine service through AJAJRequest() in cube.min.js:
 *
 *   POST /api/new_game/            -> {game_id}                 called when "Start Playing" / "Play again" is clicked
 *   POST /api/get_level_best_times -> {bestTimes[8], best_time} per-level record shown as "Best:" in the HUD
 *   POST /api/get_best_times       -> {records[], best_time}    top scores / "Fastest Total Time" on the end screen
 *   POST /api/seed/                -> {seed}                    anti-cheat nonce requested before each score upload
 *   POST /api/post/                -> {success}                 uploads {completed_time, level_id, game_id, ...}
 *
 * (get_stats, get_player_stats and delete_user are only reachable with a Google+ Games OAuth token,
 *  which cannot exist any more, so they just answer like the real server did without a token.)
 *
 * This file answers those calls locally and keeps the records in this browser's localStorage.
 * The response shapes are copied from the archived responses in /api/. The game code is unchanged:
 * cube.min.js simply hands /api/* requests to CubeLocalServer.request() (see AJAJRequest).
 *
 * Options (define BEFORE this script in index.html):
 *   var CUBE_LOCAL_SERVER = false;                         // disable, use real network requests instead
 *   var CUBE_LOCAL_SERVER_OPTIONS = { useArchivedRecords: true };
 *       // also show the archived 2012 world records as the "Best" times to beat (see ARCHIVED below)
 */
(function () {
	'use strict';

	var STORE_KEY = 'cube.localserver.v1';
	var LEVELS = 8;                       // GGame_Levels.length in cube.min.js

	// Anonymous aggregate values captured in the archived /api/get_level_best_times response.
	// Level 1 = 1.1 s is clearly a glitch/exploit record, which is why this is opt-in.
	var ARCHIVED = {
		bestTimes: [1106, 9965, 2266, 4783, 21848, 11062, 37450, 45031],
		best_time: 164995
	};

	var options = window.CUBE_LOCAL_SERVER_OPTIONS || {};
	var games = {};                       // game_id -> { levels: { 1: ms, ... } }   (per page load, like a server session)

	// ------------------------------------------------------------------ persistence
	function emptyState() {
		var lb = [];
		for (var i = 0; i < LEVELS; i++) lb.push(null);
		return { levelBest: lb, runs: [] };    // runs: [{ time, date, levels:[ms x 8] }]
	}
	var state = emptyState();
	try {
		var raw = window.localStorage.getItem(STORE_KEY);
		if (raw) {
			var parsed = JSON.parse(raw);
			if (parsed && parsed.levelBest && parsed.levelBest.length === LEVELS && parsed.runs) state = parsed;
		}
	} catch (e) { /* storage unavailable: keep records in memory for this page load */ }

	function save() {
		try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
	}

	// ------------------------------------------------------------------ helpers
	function ok(data, message) { data.success = 1; data.message = message; return data; }
	function fail(message) { return { success: 0, message: message }; }

	function bestTotal() {
		var best = null, i;
		for (i = 0; i < state.runs.length; i++) if (best === null || state.runs[i].time < best) best = state.runs[i].time;
		if (options.useArchivedRecords && (best === null || ARCHIVED.best_time < best)) best = ARCHIVED.best_time;
		return best;
	}

	function levelBests() {
		var out = [], i, v;
		for (i = 0; i < LEVELS; i++) {
			v = state.levelBest[i];
			if (options.useArchivedRecords && (v === null || ARCHIVED.bestTimes[i] < v)) v = ARCHIVED.bestTimes[i];
			out.push(v);                      // null = no record yet; the game treats null like "undefined"
		}
		return out;
	}

	function isNum(v) { return v !== '' && v !== null && v !== undefined && isFinite(Number(v)); }

	// ------------------------------------------------------------------ endpoints
	var endpoints = {
		new_game: function () {
			var id = 'local-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
			games[id] = { levels: {} };
			return ok({ game_id: id }, 'Game Id sent');
		},

		seed: function () {
			return ok({ seed: Math.floor(Math.random() * 2147483647) }, 'Seed sent');
		},

		post: function (p) {
			if (!isNum(p.completed_time) || !isNum(p.level_id) || !isNum(p.score_token))
				return fail('The data sent was not valid. Score, level and time must be numeric.');
			var game = games[p.game_id];
			var level = Math.floor(Number(p.level_id));
			var time = Math.round(Number(p.completed_time));
			if (!game) return fail('Game not found.');
			if (level < 1 || level > LEVELS || time < 0) return fail('The data sent was not valid.');

			game.levels[level] = time;
			if (state.levelBest[level - 1] === null || time < state.levelBest[level - 1]) state.levelBest[level - 1] = time;

			// Finishing the last level with every level recorded = a completed game.
			if (level === LEVELS) {
				var total = 0, all = [], i;
				for (i = 1; i <= LEVELS; i++) {
					if (game.levels[i] === undefined) { all = null; break; }
					all.push(game.levels[i]); total += game.levels[i];
				}
				if (all) {
					state.runs.push({ time: total, date: new Date().toISOString(), levels: all });
					state.runs.sort(function (a, b) { return a.time - b.time; });
					state.runs = state.runs.slice(0, 100);
				}
			}
			save();
			return ok({}, 'Score posted');
		},

		get_level_best_times: function () {
			var d = { bestTimes: levelBests() };
			var t = bestTotal();
			if (t !== null) d.best_time = t;
			return ok(d, 'Returning level best times info.');
		},

		get_best_times: function (p) {
			var limit = isNum(p.limit) ? Math.max(0, Math.floor(Number(p.limit))) : 10;
			var offset = isNum(p.offset) ? Math.max(0, Math.floor(Number(p.offset))) : 0;
			var recs = [], i, list = state.runs.slice(offset, offset + limit);
			for (i = 0; i < list.length; i++)
				recs.push({ rank: offset + i + 1, display_name: 'You', photo_url: '', time: list[i].time });
			var d = { records: recs };
			var t = bestTotal();
			if (t !== null) d.best_time = t;
			return ok(d, 'Returning ' + recs.length + ' best times');
		},

		// Need a Google+ OAuth token, which no longer exists - answer exactly like the real server did without one.
		get_stats: function () { return fail('No OAuth 2.0 access token found.'); },
		get_player_stats: function () { return fail('No OAuth 2.0 access token found.'); },
		delete_user: function () { return fail('No OAuth 2.0 access token found.'); }
	};

	// ------------------------------------------------------------------ public interface used by AJAJRequest()
	function endpointName(url) {
		var path = String(url).split('?')[0].replace(/\/+$/, '');
		var m = /\/api\/([a-z_]+)$/.exec(path);
		return m ? m[1] : null;
	}

	window.CubeLocalServer = {
		handles: function (url) {
			return window.CUBE_LOCAL_SERVER !== false && endpointName(url) !== null;
		},

		// Same contract as AJAJRequest(url, callback, params): callback({ rc: httpStatus, data: parsedJson }), asynchronously.
		request: function (url, callback, params) {
			var name = endpointName(url);
			var handler = endpoints.hasOwnProperty(name) ? endpoints[name] : null;
			var result;
			if (handler) {
				try { result = { rc: 200, data: JSON.parse(JSON.stringify(handler(params || {}))) }; }
				catch (e) { result = { rc: 500, data: '' }; }
			} else {
				result = { rc: 404, data: '' };
			}
			setTimeout(function () { callback(result); }, 0);
			return true;
		},

		// Handy from the console:  CubeLocalServer.reset()
		reset: function () { state = emptyState(); games = {}; save(); },
		dump: function () { return JSON.parse(JSON.stringify(state)); }
	};
})();
