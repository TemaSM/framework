// Copyright 2012-2017 (c) Peter Širka <petersirka@gmail.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

/**
 * @module FrameworkMail
 * @version 2.4.0
 */

'use strict';

const Net = require('net');
const Tls = require('tls');
const Events = require('events');
const Fs = require('fs');

const CRLF = '\r\n';
const REG_ESMTP = /\besmtp\b/i;
const REG_STATE = /\d+/;
const EMPTYARRAY = [];
const REG_WINLINE = /\r\n/g;
const REG_NEWLINE = /\n/g;

var INDEXSENDER = 0;
var INDEXATTACHMENT = 0;

if (!global.framework_utils)
	global.framework_utils = require('./utils');

/**
 * Mailer
 * @class
 * @property {Boolean} debug Debug mode (true/false).
 */
function Mailer() {
	this.debug = false;
	this.Message = Message;
	this.Mail = Message;
	this.connections = {};
}

Mailer.prototype.__proto__ = Object.create(Events.EventEmitter.prototype, {
	constructor: {
		value: Mailer,
		enumberable: false
	}
});

/**
 * Create Mail Message
 * @param {String} subject
 * @param {String} body
 * @return {MailMessage}
 */
Mailer.prototype.create = function(subject, body) {
	return new Message(subject, body);
};

/**
 * Message send callback
 * @callback ResolveMxCallback
 * @param {Error} err Error handling.
 * @param {Socket} socket Net socket.
 */

/**
 * Mail Message
 * @param {String} subject
 * @param {String} body
 * @property {String} subject
 * @property {String} body
 */
function Message(subject, body) {
	this.subject = subject || '';
	this.body = body || '';
	this.files;
	this.addressTo = [];
	this.addressReply;
	this.addressCC;
	this.addressBCC;
	this.addressFrom = { name: '', address: '' };
	this.closed = false;
	this.tls = false;
	this.$callback;
	// Supports (but it's hidden):
	// this.headers;
	// this.$unsubscribe;
}

Message.prototype.unsubscribe = function(url) {
	var tmp = url.substring(0, 6);
	this.$unsubscribe = tmp === 'http:/' || tmp === 'https:' ? '<' + url + '>' : '<mailto:' + url + '>';
	return this;
};

Message.prototype.callback = function(fn) {
	this.$callback = fn;
	return this;
};

Message.prototype.sender = function(address, name) {
	return this.from(address, name);
};

Message.prototype.from = function(address, name) {

	if (address[address.length - 1] === '>') {
		var index = address.indexOf('<');
		name = address.substring(0, index - 1);
		address = address.substring(index + 1, address.length - 1);
	}

	this.addressFrom.name = name || '';
	this.addressFrom.address = address;
	return this;
};

Message.prototype.to = function(address, name, clear) {

	if (typeof(name) === 'boolean') {
		clear = name;
		name = undefined;
	}

	if (address[address.length - 1] === '>') {
		var index = address.indexOf('<');
		name = address.substring(0, index - 1);
		address = address.substring(index + 1, address.length - 1);
	}

	if (clear)
		this.addressTo = [];

	if (name)
		this.addressTo.push({ email: address, name: name });
	else
		this.addressTo.push(address);

	return this;
};

Message.prototype.cc = function(address, name, clear) {

	if (typeof(name) === 'boolean') {
		clear = name;
		name = undefined;
	}

	if (address[address.length - 1] === '>') {
		var index = address.indexOf('<');
		name = address.substring(0, index - 1);
		address = address.substring(index + 1, address.length - 1);
	}

	if (clear || !this.addressCC)
		this.addressCC = [];

	if (name)
		this.addressCC.push({ email: address, name: name });
	else
		this.addressCC.push(address);

	return this;
};

Message.prototype.bcc = function(address, clear) {
	if (clear || !this.addressBCC)
		this.addressBCC = [];
	this.addressBCC.push(address);
	return this;
};

Message.prototype.reply = function(address, clear) {
	if (clear || !this.addressReply)
		this.addressReply = [];
	this.addressReply.push(address);
	return this;
};

Message.prototype.attachment = function(filename, name) {
	if (!name)
		name = framework_utils.getName(filename);
	var extension = framework_utils.getExtension(name);
	if (!this.files)
		this.files = [];
	this.files.push({ name: name, filename: filename, contentType: framework_utils.getContentType(extension), extension: extension });
	return this;
};

/**
 * Clears a timeout for sending emails (if the email is sent through the F.onMail)
 * @return {Message}
 */
Message.prototype.manually = function() {
	this.$sending && clearTimeout(this.$sending);
	return this;
};

/**
 * Adds an inline attachment.
 * Inline attachments are exactly like normal attachments except that they are represented with the 'Content-ID' (cid)
 * which can be referenced in the email's html body. For example an inline attachments (image) with a contentId of 'AB435BH'
 * can be used inside the html body as "<img src='cid:AB435BH'>". An enabled web client then can render and show the embedded image.
 *
 * @param {String} filename Filename with extension (e.g. '/local/path/123.jpg')
 * @param {String} name the optional filename (e.g. '123.jpg')
 * @param {String} contentId the Content-ID (e.g. 'AB435BH'), must be unique across the email
 * @returns {Message}
 */
Message.prototype.attachmentInline = function(filename, name, contentId) {
	if (!name)
		name = framework_utils.getName(filename);
	if (!this.files)
		this.files = [];
	var extension = framework_utils.getExtension(name);
	this.files.push({ name: name, filename: filename, contentType: framework_utils.getContentType(extension), disposition: 'inline', contentId: contentId, extension: extension });
	return this;
};

/**
 * Send e-mail
 * @param {String} smtp SMTP server / hostname.
 * @param {Object} options Options (optional).
 * @param {Function(err)} fnCallback
 * @return {Message}
 */
Message.prototype.send = function(smtp, options, callback) {
	mailer.send(smtp, options, this, callback);
	return this;
};

Mailer.prototype.switchToTLS = function(obj, options) {

	var self = this;

	obj.tls = true;
	obj.socket.removeAllListeners();

	var opt = framework_utils.copy(options.tls, { socket: obj.socket, host: obj.socket.$host, ciphers: 'SSLv3' });
	obj.socket2 = Tls.connect(opt, () => self._send(obj, options, true));

	obj.socket2.on('error', function(err) {

		mailer.destroy(obj);
		self.closed = true;
		self.callback && self.callback(err);
		self.callback = null;

		if (obj.try || err.stack.indexOf('ECONNRESET') !== -1)
			return;

		try {
			mailer.emit('error', err, obj);
		} catch(e) {
			F.error(err, 'FrameworkMail');
		}
	});

	obj.socket2.on('clientError', function(err) {
		mailer.destroy(obj);
		self.callback && self.callback(err);
		self.callback = null;

		if (obj.try)
			return;

		try {
			mailer.emit('error', err, obj);
		} catch(e) {
			F.error(err, 'FrameworkMail');
		}
	});

	obj.socket2.on('connect', () => !options.secure && self._send(obj, options));
};

Mailer.prototype.destroy = function(obj) {

	if (obj.destroyed)
		return this;

	obj.destroyed = true;
	obj.closed = true;

	if (obj.socket) {
		obj.socket.removeAllListeners();
		obj.socket.end();
		obj.socket.destroy();
		obj.socket = null;
	}

	if (obj.socket2) {
		obj.socket2.removeAllListeners();
		obj.socket2.end();
		obj.socket2.destroy();
		obj.socket2 = null;
	}

	delete this.connections[obj.id];
	return this;
};

/**
 * Internal: Write attachment into the current socket
 * @param  {Function} write  Write function.
 * @param  {String} boundary Boundary.
 * @param  {Socket} socket   Current socket.
 */
Mailer.prototype._writeattachment = function(obj) {

	var attachment = obj.files ? obj.files.shift() : false;
	if (!attachment) {
		mailer._writeline(obj, '--' + obj.boundary + '--', '', '.');
		return this;
	}

	var name = attachment.name;
	var stream = Fs.createReadStream(attachment.filename, { encoding: 'base64' });
	var message = [];
	var extension = attachment.extension;
	var isCalendar = extension === 'ics';

	message.push('--' + obj.boundary);

	if (!isCalendar) {
		if (attachment.contentId) {
			message.push('Content-Disposition: inline; filename="' + name + '"');
			message.push('Content-ID: <' + attachment.contentId + '>');
		} else
			message.push('Content-Disposition: attachment; filename="' + name + '"');
	}

	message.push('Content-Type: ' + extension + ';' + (isCalendar ? ' charset="utf-8"; method=REQUEST' : ''));
	message.push('Content-Transfer-Encoding: base64');
	message.push(CRLF);
	mailer._writeline(obj, message.join(CRLF));

	stream.on('data', function(buf) {

		var length = buf.length;
		var count = 0;
		var beg = 0;

		while (count < length) {

			count += 68;
			if (count > length)
				count = length;

			mailer._writeline(obj, buf.slice(beg, count).toString('base64'));
			beg = count;
		}
	});

	CLEANUP(stream, function() {
		mailer._writeline(obj, CRLF);
		mailer._writeattachment(obj);
	});

	return this;
};

Mailer.prototype.try = function(smtp, options, callback) {
	return this.send(smtp, options, undefined, callback);
};

Mailer.prototype.send2 = function(messages, callback) {

	var opt = F.temporary['mail-settings'];

	if (!opt) {
		var config = F.config['mail.smtp.options'];
		if (config) {
			if (typeof(config) === 'object')
				opt = config;
			else
				opt = config.toString().parseJSON();
		}

		if (!opt)
			opt = {};

		F.temporary['mail-settings'] = opt;
	}

	return this.send(F.config['mail.smtp'], opt, messages, callback);
};

Mailer.prototype.send = function(smtp, options, messages, callback) {

	if (options instanceof Array) {
		callback = messages;
		messages = options;
		options = {};
	} else if (typeof(options) === 'function') {
		callback = options;
		options = {};
	}

	var self = this;
	var id = 'abcdefghijkl' + (INDEXSENDER++);

	self.connections[id] = {};
	var obj = self.connections[id];

	obj.id = id;
	obj.try = messages === undefined;
	obj.messages = obj.try ? EMPTYARRAY : messages instanceof Array ? messages : [messages];
	obj.callback = callback;
	obj.closed = false;
	obj.message = null;
	obj.files = null;
	obj.count = 0;
	obj.socket;
	obj.tls = false;
	obj.date = global.F ? global.F.datetime : new Date();

	smtp = smtp || null;

	if (options && options.secure && !options.port)
		options.port = 465;

	options = framework_utils.copy(options, { secure: false, port: 25, user: '', password: '', timeout: 10000, tls: null });

	if (options.secure) {
		var internal = framework_utils.copy(options);
		internal.host = smtp;
		obj.socket = Tls.connect(internal, () => mailer._send(obj, options));
	} else
		obj.socket = Net.createConnection(options.port, smtp);

	obj.socket.$host = smtp;
	obj.host = smtp.substring(smtp.lastIndexOf('.', smtp.lastIndexOf('.') - 1) + 1);
	obj.socket.on('error', function(err) {

		mailer.destroy(obj);
		obj.callback && obj.callback(err);
		obj.callback = null;

		if (obj.try || err.stack.indexOf('ECONNRESET') !== -1)
			return;

		try {
			mailer.emit('error', err, obj);
		} catch(e) {
			F.error(err, 'FrameworkMail');
		}
	});

	obj.socket.on('clientError', function(err) {

		mailer.destroy(obj);
		obj.callback && obj.callback(err);
		obj.callback = null;

		if (obj.try)
			return;

		try {
			mailer.emit('error', err, obj);
		} catch(e) {
			F.error(err, 'FrameworkMail');
		}
	});

	obj.socket.on('connect', () => !options.secure && mailer._send(obj, options));
	return self;
};

Mailer.prototype._writemessage = function(obj, buffer) {

	var self = this;
	var msg = obj.messages.shift();
	var message = [];


	if (global.F)
		global.F.stats.other.mail++;

	obj.boundary = '--totaljs' + obj.date.getTime() + obj.count;
	obj.files = msg.files;
	obj.count++;

	buffer.push('MAIL FROM: <' + msg.addressFrom.address + '>');
	message.push('Message-ID: <total' + (INDEXATTACHMENT++) + '@WIN-t' + (INDEXATTACHMENT) + '>');
	message.push('MIME-Version: 1.0');
	message.push('From: ' + (msg.addressFrom.name ? unicode_encode(msg.addressFrom.name) + ' <' + msg.addressFrom.address + '>' : msg.addressFrom.address));

	var length;

	if (msg.headers) {
		var headers = Object.keys(msg.headers);
		for (var i = 0, length = headers.length; i < length; i++)
			message.push(headers[i] + ': ' + msg.headers[headers[i]]);
	}

	length = msg.addressTo.length;

	var builder = '';
	var mail;
	var item;

	if (length) {
		for (var i = 0; i < length; i++) {
			item = msg.addressTo[i];
			if (item instanceof Object)
				mail = '<' + item.email + '>';
			else
				mail = '<' + item + '>';
			buffer.push('RCPT TO: ' + mail);
			builder += (builder ? ', ' : '') + (item instanceof Object ? unicode_encode(item.name) + ' ' : '') + mail;
		}
		message.push('To: ' + builder);
		builder = '';
	}

	if (msg.addressCC) {
		length = msg.addressCC.length;
		for (var i = 0; i < length; i++) {
			item = msg.addressCC[i];
			if (item instanceof Object)
				mail = '<' + item.email  + '>';
			else
				mail = '<' + item + '>';
			buffer.push('RCPT TO: ' + mail);
			builder += (builder ? ', ' : '') + (item instanceof Object ? unicode_encode(item.name) + ' ' : '') + mail;
		}
		message.push('Cc: ' + builder);
		builder = '';
	}

	if (msg.addressBCC) {
		length = msg.addressBCC.length;
		for (var i = 0; i < length; i++)
			buffer.push('RCPT TO: <' + msg.addressBCC[i] + '>');
	}

	buffer.push('DATA');
	buffer.push('');

	message.push('Date: ' + obj.date.toUTCString());
	message.push('Subject: ' + unicode_encode(msg.subject));
	msg.$unsubscribe && message.push('List-Unsubscribe: ' + msg.$unsubscribe);

	if (msg.addressReply) {
		length = msg.addressReply.length;
		for (var i = 0; i < length; i++)
			builder += (builder !== '' ? ', ' : '') + '<' + msg.addressReply[i] + '>';
		message.push('Reply-To: ' + builder);
		builder = '';
	}

	message.push('Content-Type: multipart/mixed; boundary=' + obj.boundary);
	message.push('');
	message.push('--' + obj.boundary);
	message.push('Content-Type: ' + (msg.body.indexOf('<') !== -1 && msg.body.lastIndexOf('>') !== -1 ? 'text/html' : 'text/plain') + '; charset=utf-8');
	message.push('Content-Transfer-Encoding: base64');
	message.push('');
	message.push(prepareBASE64(framework_utils.createBuffer(msg.body.replace(REG_WINLINE, '\n').replace(REG_NEWLINE, CRLF)).toString('base64')));

	obj.message = message.join(CRLF);
	obj.messagecallback = msg.$callback;

	message = null;
	return self;
};

Mailer.prototype._writeline = function(obj) {

	if (obj.closed)
		return false;

	var socket = obj.socket2 ? obj.socket2 : obj.socket;

	for (var i = 1; i < arguments.length; i++) {
		var line = arguments[i];
		if (line) {
			mailer.debug && console.log('SEND', line);
			socket.write(line + CRLF);
		}
	}

	return true;
};

Mailer.prototype._send = function(obj, options, autosend) {

	var self = this;
	var buffer = [];
	var isAuthenticated = false;
	var isAuthorization = false;
	var command = '';
	var auth = [];
	var response = '';
	var socket = obj.socket2 ? obj.socket2 : obj.socket;
	var host = obj.host;

	var isAttach = !options.tls || (obj.tls && options.tls);

	isAttach && mailer.emit('send', obj);
	socket.setEncoding('utf8');
	socket.setTimeout(options.timeout || 8000, function() {

		var err = new Error(framework_utils.httpStatus(408));

		mailer.destroy(obj);
		obj.callback && obj.callback(err);
		obj.callback = null;

		if (obj.try)
			return;

		try {
			mailer.emit('error', err, obj);
		} catch(e) {
			F.error(err, 'FrameworkMail');
		}
	});

	socket.on('end', function() {
		mailer.destroy(obj);
		obj.callback && obj.callback();
		obj.callback = null;
	});

	socket.on('data', function(data) {

		if (obj.closed)
			return;

		data = data.toString('utf8');

		if (!data.endsWith(CRLF)) {
			response += data;
			return;
		}

		var res = (response + data).split(CRLF);

		if (response)
			response = '';

		for (var i = 0, length = res.length; i < length; i++) {
			var line = res[i];
			line && socket && socket.emit('line', line);
		}
	});

	socket.on('line', function(line) {

		line = line.toUpperCase();
		mailer.debug && console.log('<---', line);

		var code = +line.match(REG_STATE)[0];

		if (code === 250 && !isAuthorization) {
			if ((line.indexOf('AUTH LOGIN PLAIN') !== -1 || line.indexOf('AUTH PLAIN LOGIN') !== -1) || (options.user && options.password)) {
				isAuthorization = true;
				if (line.indexOf('XOAUTH') === -1) {
					auth.push('AUTH LOGIN');
					auth.push(framework_utils.createBuffer(options.user).toString('base64'));
					auth.push(framework_utils.createBuffer(options.password).toString('base64'));
				} else
					auth.push('AUTH PLAIN ' + framework_utils.createBuffer('\0'+ options.user + '\0' + options.password).toString('base64'));
			}
		}

		// help
		if (line.substring(3, 4) === '-')
			return;

		if (!isAuthenticated && isAuthorization) {
			isAuthenticated = true;
			code = 334;
		}

		switch (code) {
			case 220:

				if (obj.isTLS) {
					mailer.switchToTLS(obj, options);
					return;
				}

				command = obj.isTLS || (options.user && options.password) || REG_ESMTP.test(line) ? 'EHLO' : 'HELO';
				mailer._writeline(obj, command + ' ' + host);
				break;

			case 250: // OPERATION
			case 251: // FORWARD
			case 235: // VERIFY
			case 999: // total.js again

				obj.messagecallback && obj.messagecallback();
				obj.messagecallback = null;
				mailer._writeline(obj, buffer.shift());

				if (buffer.length)
					return;

				// NEW MESSAGE
				if (obj.messages.length) {
					mailer._writemessage(obj, buffer);
					mailer._writeline(obj, buffer.shift());
					return;
				}

				// end
				mailer._writeline(obj, 'QUIT');
				return;

			case 221: // BYE
				mailer.destroy(obj);
				obj.callback && obj.callback(null, obj.try ? true : obj.count);
				obj.callback = null;
				return;

			case 334: // LOGIN

				if (!self.tls && !obj.isTLS && options.tls) {
					obj.isTLS = true;
					mailer._writeline(obj, 'STARTTLS');
					return;
				}

				var value = auth.shift();
				if (!value) {

					var err = new Error('Forbidden.');

					mailer.destroy(obj);
					obj.callback && obj.callback(err);
					obj.callback = null;

					if (obj.try)
						return;

					try {
						mailer.emit('error', err, obj);
					} catch(e) {
						F.error(err, 'FrameworkMail');
					}

					return;
				}

				mailer._writeline(obj, value);
				return;

			case 354:
				mailer._writeline(obj, obj.message);
				mailer._writeattachment(obj);
				obj.message = null;
				return;

			default:

				if (code < 400)
					return;

				var err = new Error(line);

				if (!obj.try) {
					try {
						mailer.emit('error', err, obj);
					} catch(e) {
						F.error(err, 'FrameworkMail');
					}
				}

				obj.messagecallback && obj.messagecallback(err);
				obj.messagecallback = null;

				if (obj.message) {
					// a problem
					buffer = [];
					obj.count--;
					socket.emit('line', '999 TRY NEXT MESSAGE');
					return;
				}

				mailer.destroy(obj);
				obj.callback && obj.callback(err);
				obj.callback = null;
				return;
		}
	});

	autosend && self._writeline(obj, 'EHLO ' + host);
};

Mailer.prototype.restart = function() {
	var self = this;
	self.removeAllListeners();
	self.debug = false;
	INDEXSENDER = 0;
	INDEXATTACHMENT = 0;
};

// Split Base64 to lines with 68 characters
function prepareBASE64(value) {

	var index = 0;
	var output = '';
	var length = value.length;

	while (index < length) {
		var max = index + 68;
		if (max > length)
			max = length;
		output += value.substring(index, max) + CRLF;
		index = max;
	}

	return output;
}

function unicode_encode(val) {
	return val ? '=?utf-8?B?' + framework_utils.createBuffer(val.toString()).toString('base64') + '?=' : '';
}

// ======================================================
// EXPORTS
// ======================================================

var mailer = new Mailer();
module.exports = mailer;