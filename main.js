#!/usr/bin/node

// ** Includes **  
const assert = require('node:assert');
const fs = require('node:fs');
const proc			   = require('child_process');
const http			   = require("node:http");
const url 			   = require('node:url');

const blessed = require('blessed');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');


// ** Constants **
const PROCESS_NAME = "mags";

const HOME 			   = process.env.HOME;
const PATH		       = ['/etc/mags', `${HOME}/.mags/`];
const CONF_FILENAME    = 'mags.conf';
const THEME_FILENAME   = 'theme.json';

const HISTORY_FILENAME = `${HOME}/.mags/mags_history`;

const JACKETT_URL_DEFAULT = "http://localhost:9117";

const PEERFLIX_OPTS = '-lk';
const MPV_OPTS = '--save-position-on-quit=no';
// ...


// ** Globals **
var options = null;
var screen = null;

var search_tabs = null;
var search_bar = null;

var list_prototype = {
	keys: true,
	top: 1,
	tags: true,
	height: '100%-2',
	interactive: true,
};

var xml_parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_", 
	cdataPropName: "#cdata"    
});
// ...


// ** Utils **
function expect(s, l) {
	if(l.length < s.length || s != l.substr(0, s.length)) 
		return null;

	return l.slice(s.length);
}

// ** Jackett **
function new_search_jackett(query, results_callback) {
	let jackett_query = new URL(options['jackett-url']);
	jackett_query.pathname = "/api/v2.0/indexers/all/results/torznab/api";
	jackett_query.search = `?apikey=${options['jackett-api']}&t=search&q=${query}`;

	http.get(jackett_query, (res) => {
		if (res.statusCode !== 200) {
			console.error(`Got response code ${res.statusCode}`);
			res.resume();
			return;
		}
		let content_type = res.headers['content-type'];

		res.setEncoding('utf8');
		let rawData = '';
		res.on('data', (chunk) => { rawData += chunk; });
		res.on('end', () => {
			const obj = xml_parser.parse(rawData);
			results_callback(obj);
		});
	}).on('error', (e) => {
		console.error(`Got error: ${e.message}`);
	});
}

function get_magnet_jackett(link, result_callback) {
	if(/magnet:.*/.test(link)) { 
		// we got the magnet link
		return result_callback(link);
	} 

	http.get(link, (res) => {
		switch(res.statusCode) {
			case 200: // OK
				break;
			case 302: // Found
				new_url = res.headers['location'];
				return get_magnet_jackett(new_url, result_callback);

			default:
				console.error(`Got response code ${res.statusCode}`);
				res.resume(); 
				return;
		}
	}).on('error', (e) => {
		console.error(`Got error: ${e.message}`);
	});
}

// ** Search List **
function add_torznab_to_list(list, torznab) {
	const indexer = torznab.jackettindexer['@_id'];

	var seeders = undefined;
	var peers   = undefined;
	for(const attr of torznab['torznab:attr']) {
		switch(attr['@_name']) {
			case 'seeders': 
				seeders = attr['@_value']; 
				break;
			case 'peers': 
				peers = attr['@_value']; 
				break;
		}
	}

	const left = blessed.escape(`${torznab.title}`); 
	const right = blessed.escape(`(${indexer}) S:${String(seeders).padEnd(6)} L:${String(peers).padEnd(6)}`);
	const entry_element = list.addItem(`${left}{|}{bold}${right}{/bold}`);

	entry_element.dl_link = torznab.link;
}

function new_search(txt) {
	let list = blessed.list(list_prototype);
	screen.append(list);

	search_tabs.add(txt, () => {
		// hide all the other lists
		for(const r of screen.children) {
			if(r.type == 'list') {
				r.hide();
			}
		}
		// show this list
		list.show();
		list.focus();

		screen.render();
	});
	search_tabs.selectTab(search_tabs.items.length - 1);

	new_search_jackett(txt, (xml) => {
		if(!list || !xml.rss.channel.item) {
			return;
		}
		
		// make sure it is an array
		const i = [].concat(xml.rss.channel.item);
		for(const response_item of i) {
			add_torznab_to_list(list, response_item);
		}

		screen.render();
	});

	list.on('select', (item, index) => {
		if(!item) return;

		const link = item.dl_link;
		get_magnet_jackett(link, (data) => {
			screen.destroy();

			var peerflix = proc.spawn("peerflix", 
				[PEERFLIX_OPTS, data, '--', MPV_OPTS], {
				stdio: 'inherit',
			});
			peerflix.on('exit', (code, signal) => {
				console.log('peerflix exited', { code, signal });
				return process.exit(code);
			});
		});
	});
}

function parse_argv(options, argv) {
	for(const arg of argv) {
		if(!arg) continue;

		let o = expect("--", arg);
		if(!o || o.length <= 0) continue;

		let ob = o.split('=');
		if(ob.length > 1) {
			options[ob[0]] = ob[1];
		} else {
			options[ob[0]] = true;
		}
	}
}
function parse_conf(options, conf) {
	const lines = conf.split('\n');

	for(const line of lines) {
		if(!line) continue;

		let ob = line.split('=');
		ob[0] = ob[0].trim();

		if(ob.length > 1) {
			options[ob[0]] = ob[1].trim();
		} else {
			options[ob[0]] = true;
		}
	}
}

function config(argv, search_path, filename, options_definition) {
	// * generate help message from definition *
	var help = `Usage: ${PROCESS_NAME} [option]...\n` +
			   "\n"									+
			   "  options:\n";
	for(const def of options_definition) {
		help += `    --${def.name}: ${def.description}` + 
			(def.default !== undefined && def.default !== null ?
				`\t (default: ${def.default})` : '') + '\n';
	}

	// * aggregate given options respecting priorities *
	var options = {};
	for(const dir of search_path) {
		try {
			let f = fs.readFileSync(`${dir}/${filename}`).toString();
			parse_conf(options, f);
		} catch(e) {
			if(e.code == 'ENOENT') 
				continue;
			console.error('error:', e.message);
			return null;
		}
	}
	parse_argv(options, argv);

	// * if --help print help and exit *
	if(options['help']) { 
		console.log(help);
		return process.exit(0);
	}

	// * check options against definition *
	for(const def of options_definition) {
		if(options[def.name] === undefined) {
			if(def.default === undefined || def.default === null) {
				console.error(`error: ${def.name} was not provided. See --help.`);
				return null;
			}
			options[def.name] = def.default;
		}
	}

	return options;
}

function main(argv) {
	// * Configuration *
	options = config(argv, PATH, CONF_FILENAME, [
		{ name: 'jackett-url', description: 'URL of your jackett instance.', default: JACKETT_URL_DEFAULT },
		{ name: 'jackett-api', description: 'API key for your jackett instance.'},
	]);
	if(!options)
		return process.exit(1);

	for(const dir of PATH) {
		try {
			let theme_file = fs.readFileSync(`${dir}/${THEME_FILENAME}`).toString();
			var theme = JSON.parse(theme_file);
		} catch(e) {
			if(e.code == 'ENOENT') 
				continue;
			console.error('error: Could not parse theme file:', e.message);
			return process.exit(1);
		}	
	}
	assert(theme && theme.search_tabs && theme.search_bar && theme.list, 
		"Theme file does not exist or does not define the required styles.");


	// * Init TUI *
	screen = blessed.screen({
		title: 'mags',
		smartCSR: true,
		terminal: "xterm-256color",
	});

	search_tabs = blessed.listbar({
		autoCommandKeys: true,
		top: 0,
		height: 1,
		width: '100%',
		style: theme.search_tabs,
	});
	search_bar = blessed.textbox({
		keys: true,
		focusable: true,
		inputOnFocus: true,
		bottom: 0,
		width: '100%',
		height: 1,
		style: theme.search_bar,
	});
	screen.append(search_tabs);
	screen.append(search_bar);

	list_prototype.style = theme.list;

	// * History *
	var history = [];
	try {
		history = fs.readFileSync(HISTORY_FILENAME).toString().trim().split('\n');
	} catch(e) {
		if(e.code != 'ENOENT') {
			console.error("error:", e.message);
			return process.exit(1);
		}
	}
	const old_history_length = history.length;
	var history_current = history.length;

	// * Main Events *
	screen.key('/', (ch, key) => {
		search_bar.focus();

		history_current = history.length;
		search_bar.clearValue();
	});
	search_bar.on('submit', () => {
		var search_text = search_bar.getValue();
		new_search(search_text);


		history.push(search_text);
		history_current = history.length;
		search_bar.clearValue();
	});
	search_bar.key('up', (ch, key) => {
		assert(history_current >= 0);
		let history_previous = history_current - 1;

		if(history_previous >= 0) {
			search_bar.setValue(history[history_previous]);
			history_current--;
		}

		screen.render();
	});
	search_bar.key('down', (ch, key) => {
		assert(history_current <= history.length);
		let history_next = history_current + 1;

		if(history_next < history.length) {
			search_bar.setValue(history[history_next]);
			history_current++;
		} else if(history_next == history.length) {
			search_bar.clearValue('');
			history_current++;
		}

		screen.render();
	});
	screen.key(['escape', 'q', 'C-c'], (ch, key) => {
		// save new history
		try {
			fs.appendFileSync(HISTORY_FILENAME, 
				history.slice(old_history_length).join('\n') + '\n');
		} catch(e) {
			console.warn("warn: could not save search to history file:", e.message);
		}

		return process.exit(0);
	});

	screen.render();
}

main(process.argv);
