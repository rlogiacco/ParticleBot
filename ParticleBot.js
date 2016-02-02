var _ = require('lodash');
var debug = require('debug')('particle-bot');
var Particle = require('spark');
var TelegramBot = require('node-telegram-bot-api');
var EventSource = require('eventsource');
 
var bot = new TelegramBot('181576321:AAH_sU0Gqd-A6wy8yGS2IfD2gQmcpjuIagw', { polling: true });

var bridges = {};

function addToken(msg, token) {
  if (token) {
    var client = new Particle();
    client.login({ accessToken: token });
    client.eventListeners = {};
    bridges[msg.chat.id + ',' + msg.from.id] = client;
    bot.sendChatAction(msg.chat.id, "typing");
    return listDevices(msg).catch(function(err) {
      bot.sendMessage(msg.from.id, 'Provided token is invalid, sorry.')
    });
  }
};

function login(msg, credentials) {
  if (credentials && credentials.length == 2) {
    var client = new Particle();
    bot.sendChatAction(msg.chat.id, "typing");
    client.login({ username: credentials[0], password: credentials[1]})
    .then(function() {
      client.eventListeners = {};
      bridges[msg.chat.id + ',' + msg.from.id] = client;
      return listDevices(msg).catch(function(err) {
        bot.sendMessage(msg.from.id, 'Provided credentials are invalid, sorry.')
      });
    });
  }
};

function listDevices(msg) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];

  return client.listDevices().then(function(response) {
    var message = 'Your devices are: ';
    _.each(_.map(response, 'name'), function(value) {
      message += '\n   *' + value + '*';
    });
    message += "\n\nPlease pick the one I'll bridge to..."
    return bot.sendMessage(msg.from.id, message, keyboards.deviceNames(response))
    .then(bot.waitResponse(msg, 10000))
    .then(function(msg) { return open(msg, [msg.text]); })
    .catch(function() { return bot.sendMessage(msg.from.id, "Are you lazy or what?", keyboards.commands); });
  });
};

function open(msg, args) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];
  var setDevice = function(response, msg) {
    client.device = {id: _.find(response, {name: msg.text}).id, name: msg.text};
    if (client.device.id) {
      return bot.sendMessage(msg.from.id, 'Ok, now talking to *' + client.device.name + '* on your behalf', keyboards.commands);
    } else {
      return bot.sendMessage(msg.from.id, 'Device *' + client.device.name + '* not found: did you pick one from the list?', { parse_mode: 'markdown' });
    }
  };

  if (!args || args.length == 0) {
    return client.listDevices().then(function(response) {
      return bot.sendMessage(msg.from.id, 'Select a device: ' + _.join(_.map(response, 'name')), keyboards.deviceNames(response))
      .then(bot.waitResponse(msg, 10000))
      .then(function(msg) { return setDevice(response, msg); })
      .catch(function() { return bot.sendMessage(msg.from.id, "Are you lazy or what?", keyboards.commands); });;
    });
  } else {
    return client.listDevices().then(function(response) {
      msg.text = args[0];
      return setDevice(response, msg);
    });
  }
};

function info(msg) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];
  
  return client.getDevice(client.device.id)
  .then(function(device) {
    return bot.sendMessage(msg.from.id, templates.info(device), { parse_mode: 'markdown' });
  })
  .catch(function(err) {
    bot.sendMessage(msg.from.id, templates.error({device:client.device.name}));
  });;
};

function call(msg, args) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];
  
  var fnName = args.length >= 1 ? args[0] : undefined;
  var fnArg = args.length >= 2 ? args[1] : undefined;
  var promise;
  if (args.length > 0) {
    promise = client.callFunction(client.device.id, fnName, fnArg)
    .then(function(response) {
      return bot.sendMessage(msg.from.id, response.return_value, _.defaults({ reply_to_message_id: msg.message_id }, keyboards.commands));
    });
  } else {
    promise = client.getAttributes(client.device.id)
    .then(function(device) {
      
      return bot.sendMessage(msg.from.id, 'Select the function to invoke: ' + device.functions, keyboards.functions(device))
      .then(bot.waitResponse(msg))
      .then(function(msg) {
        fnName = msg.text;
        return bot.sendMessage(msg.from.id, 'Function argument value');
      })
      .then(bot.waitResponse(msg))
      .then(function(msg) {
        fnArg = msg.text;
        return client.callFunction(client.device.id, fnName, fnArg);
      })
      .then(function(response) {
        return bot.sendMessage(msg.from.id, "Next time you want to invoke this function you can use\n/call `" + fnName + "` `" + fnArg + "`\nResponse was " + response.return_value, keyboards.commands);
      });
    });
  }
  return promise.catch(function(err) {
    bot.sendMessage(msg.from.id, templates.call.error({device:client.device.name, name: fnName, arg: fnArg}));
  });
};

function read(msg, args) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];

  var varName = args.length >= 1 ? args[0] : undefined;
  var promise;
  if (varName) {
    promise = client.getVariable(client.device.id, varName)
    .then(function(response) {
      return bot.sendMessage(msg.from.id, response.result, _.defaults({ reply_to_message_id: msg.message_id }, keyboards.commands));
    });
  } else {
    promise = client.getAttributes(client.device.id)
    .then(function(device) {

      return bot.sendMessage(msg.from.id, 'Select the variable to get: ' + _.join(_.keys(device.variables)), keyboards.variables(device))
      .then(bot.waitResponse(msg))
      .then(function(msg) {
        args[0] = varName = msg.text;
        return read(msg, args);
      })
      .then(function(response) {
        return bot.sendMessage(msg.from.id, "Next time you want to get this variable you can use\n`/read " + varName + "`", keyboards.commands);
      });
    });
  }
  return promise.catch(function(err) {
    bot.sendMessage(msg.from.id, templates.read.error({device:client.device.name}));
  });
};

function listen(msg, args) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];

  var eventName = (args.length > 0 ? args[0] : undefined);
  if (client.eventListeners[eventName]) {
    bot.sendMessage(msg.from.id, templates.listen.already({event: eventName, device: client.device.name}), keyboards.commands);
  } else {

    var url = templates.url({device: client.device.id, event: eventName, accessToken: client.accessToken});
    var eventSource = client.eventListeners[eventName] = new EventSource(url);

    eventSource.on(eventName, function(event) {
      bot.sendMessage(msg.from.id, templates.listen.data({event: eventName, device: client.device.name, data: JSON.parse(event.data).data}), { parse_mode: 'markdown' })
      .catch(function(err) {
        debug('Disconnecting client %j', err);
        eventSource.close();
        delete client.eventListeners[eventName];
      });
    });
    eventSource.on('error', function() {
      debug('Event source error');
      bot.sendMessage(msg.from.id, templates.listen.error({event: eventName, device: client.device.name}), { parse_mode: 'markdown' });
    });
    bot.sendMessage(msg.from.id, templates.listen.start({event: eventName, device: client.device.name}), keyboards.commands);
  }
};

function mute(msg, args) {
  var client = bridges[msg.chat.id + ',' + msg.from.id];

  var eventName = args.length > 0 ? args[0] : undefined;
  if (client.eventListeners[eventName]) {
    client.eventListeners[eventName].close();
    delete client.eventListeners[eventName];

    bot.sendMessage(msg.from.id, templates.listen.stop({event: eventName, device: client.device.name}), keyboards.commands);
  } else {
    bot.sendMessage(msg.from.id, templates.listen.never({event: eventName, device: client.device.name}), keyboards.commands);
  }
};

var help = function (msg) {
  bot.sendMessage(msg.from.id, 
    "Please tell me your access token using /token `your access token`\n\n" + 
    "If you don't know your access token log in the [Particle build website](https://build.particle.io/login), your access token is available in the *settings* tab, the one with the gear icon.", 
    { parse_mode: 'markdown', disable_web_page_preview: true });
}



bot.onCommand('token', function (msg, args) {
  if (args[0]) {
    addToken(msg, args[0]);
  } else {
    bot.sendMessage(msg.from.id, 'What is your access token?')
    .then(bot.waitResponse(msg, 60000))
    .then(function(msg) { addToken(msg, msg.text) })
    .catch(function(err) {
      bot.sendMessage(msg.from.id, 'I can`t help you without a Particle access token, sorry.');
    });
  }
});

bot.onCommand('devices', listDevices);
bot.onCommand('open', open);
bot.onCommand('info', info);
bot.onCommand('read', read);
bot.onCommand('call', call);
bot.onCommand('listen', listen);
bot.onCommand('mute', mute);

bot.onCommand('start', help);
bot.onCommand('help', help);

bot.on('message', function (msg) {
  console.log(msg)
});

bot.onCommand('login', function (msg, args) {
  if (args.length == 2) {
    login(msg, args);
  } else {
    bot.sendMessage(msg.from.id, 'Please provide your username and password on two lines')
    .then(bot.waitResponse(msg, 60000))
    .then(function(msg) {
      login(msg, _.split(msg.text, '\n', 2)) })
    .catch(function(err) {
      bot.sendMessage(msg.from.id, 'I can`t help you without a Particle account, sorry.');
    });
  }
});



var keyboards = {
  commands: {
    parse_mode: 'markdown',
    reply_markup: { 
      keyboard: [['/open', '/info'],['/read', '/call'], ['/listen','/mute']], 
      selective: true 
    } 
  },
  template: {
    parse_mode: 'markdown',
    reply_markup: { 
      keyboard: [], one_time_keyboard: true, selective: true 
    }
  },
  variables: function(device) {
    var options = _.cloneDeep(this.template);
    options.reply_markup.keyboard = _.transform(_.keys(device.variables), function(result, val) { 
      if (result.length == 0 || result[result.length - 1].length == 2) {
        result.push([val])
      } else {
        result[result.length - 1].push(val);
      }
    }, []);
    return options;
  },
  functions: function(device) {
    var options = _.cloneDeep(this.template);
    device.functions.forEach(function(item) {
      options.reply_markup.keyboard.push([item]);
    });
    return options;
  },
  deviceNames: function(response) {
    var options = _.cloneDeep(this.template);
    response.forEach(function (device) { options.reply_markup.keyboard.push([device.name]) });
    return options;
  }
}

_.templateSettings.evaluate = /%{([\s\S]+?)}/g;
_.templateSettings.imports = {
  'escape': function(string) { return string.replace(/([\*\[\]_`])/g,'\\$1') }
}

var templates = {
  url: _.template("https://api.particle.io/v1/devices/${ device }/events/${ event }?access_token=${ accessToken }"),
  listen: {
    start: _.template("Ok, from now on I'll report here all events `${ event }` from device *%{ print(escape(device)) }*"),
    stop:  _.template("I'm no more reporting to you events `${ event }` from device *%{ print(escape(device)) }*"),
    error: _.template("`${ event }`@*%{ print(escape(device)) }*: `ERROR`"),
    data:  _.template("`${ event }`@*%{ print(escape(device)) }*: `${ data }`"),
    never: _.template("I wasn't listening for events `${ event }` from device *%{ print(escape(device)) }*"),
    already: _.template("I know, I was already listening for events `${ event }` from device *%{ print(escape(device)) }*")
  },
  info: _.template("Device *%{ print(escape(name)) }*\n" +
    "   id: _%{ print(escape(id)) }_\n" +
    "   connected: _${ connected }_\n" +
    "   last connection: _${ lastHeard }_\n" +
    "   last ip address: _${ lastIpAddress }_\n" +
    "   status: _${ status }_"),
  error: _.template("I got an error from *%{ print(escape(name)) }*: should I _destroy it_? :smile:")
}

var escape = function(string) {
  return string.replace(/([\*\[\]_`])/g,'\\$1')
}