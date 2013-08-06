Meteor.Collection.prototype.before = function (options) {
  addHook.call(this, 'before', options);
};

Meteor.Collection.prototype.after = function (options) {
  addHook.call(this, 'after', options);
};

var verbs = ['insert', 'update', 'remove'];

if (Meteor.isClient) {
  (function () {
    _.each(verbs, function (method) {
      var _super = Meteor.Collection.prototype[method];
      Meteor.Collection.prototype[method] = function () {
        var self = this;
        var hookedMethodName = '_hooked' + method.charAt(0).toUpperCase() + method.slice(1);
        var opts = {
          _super: _super,
          userId: getUserId.call(self),
          fromPublicApi: true
        };

        return self[hookedMethodName].apply(self, [opts].concat(_.toArray(arguments)));
      };
    });
  })();
}

if (Meteor.isServer) {
  (function () {
    var _defineMutationMethods = Meteor.Collection.prototype._defineMutationMethods;
    Meteor.Collection.prototype._defineMutationMethods = function () {
      var self = this;

      // Allow Meteor to set-up normal mutation methods
      _defineMutationMethods.apply(self, arguments);

      // Now that the mutation methods are setup, we can bind our interceptions
      // on the final mutation invocations, and facilitate our server-side hooks
      _.each(verbs, function (method) {
        var _super = self._collection[method];

        self._collection[method] = function () {
          var hookedMethodName = '_hooked' + method.charAt(0).toUpperCase() + method.slice(1);
          var opts = {
            _super: _super,
            userId: getUserId.call(self),
            fromPublicApi: false
          };

          self._collection._validators = self._validators;

          return self[hookedMethodName].apply(self._collection, [opts].concat(_.toArray(arguments)));
        }
      });
    };
  })();
}

function getUserId() {
  var userId;

  if (Meteor.isClient) {
    Deps.nonreactive(function () {
      userId = Meteor.userId();
    });
  }

  if (Meteor.isServer) {
    try {
      // Will work inside methods
      userId = Meteor.userId();
    } catch (e) {}
  }

  return userId;
}

// addHook is nearly identical to addValidator, pulled from
// ~/.meteor/packages/mongo-livedata/collection.js:426-459
function addHook(verb, options) {
  var VALID_KEYS = verbs.concat(['fetch', 'transform']);
  _.each(_.keys(options), function (key) {
    if (!_.contains(VALID_KEYS, key))
      throw new Error(verb + ": Invalid key: " + key);
  });

  var self = this;
  self._restricted = true;

  _.each(verbs, function (name) {
    if (options[name]) {
      if (!(options[name] instanceof Function)) {
        throw new Error(verb + ": Value for `" + name + "` must be a function");
      }
      if (self._transform)
        options[name].transform = self._transform;
      if (options.transform)
        options[name].transform = Deps._makeNonreactive(options.transform);

      // Dynamically initialize new paths in self._validators
      if (!_.has(self._validators, name))
        self._validators[name] = {};
      if (!_.has(self._validators[name], verb))
        self._validators[name][verb] = [];

      self._validators[name][verb].push(options[name]);
    }
  });

  if (options.update || options.remove || options.fetch) {
    if (options.fetch && !(options.fetch instanceof Array)) {
      throw new Error(verb + ": Value for `fetch` must be an array");
    }
    self._updateFetch(options.fetch);
  }
}

/*
var directFind = Meteor.Collection.prototype.find;
var directFindOne = Meteor.Collection.prototype.findOne;
var directInsert = Meteor.Collection.prototype.insert;
var directUpdate = Meteor.Collection.prototype.update;
var directRemove = Meteor.Collection.prototype.remove;

function delegate() {
  var i, len, c;
  var args = Array.prototype.slice.call(arguments);
  var type = args.shift();
  var verb = args.shift();

  if (this.__collection_hooks && this.__collection_hooks[type] && this.__collection_hooks[type][verb]) {
    for (i = 0, len = this.__collection_hooks[type][verb].length; i < len; i++) {
      c = this.__collection_hooks[type][verb][i];
      if (typeof c === "function") {
        if (c.apply(this, args) === false) {
          return false;
        }
      }
    }
  }
}

function getUserId() {
  var userId = null;

  if (Meteor.isClient) {
    Deps.nonreactive(function () {
      userId = Meteor.userId();
    });
  }

  if (Meteor.isServer) {
    try {
      // Will work inside methods
      userId = Meteor.userId();
    } catch (e) {}

    if (!userId) {
      userId = Meteor.__collection_hooks_publish_userId;
    }
  }

  return userId;
}

// Allow direct operations
Meteor.Collection.prototype.directFind = directFind;
Meteor.Collection.prototype.directFindOne = directFindOne;

// These are invoked when the method is called directly on the collection
// from either the server or client. These are adapted to match the
// function signature of the validated version (userId added)

// "after" hooks for find are strange and only here for completeness.
// Most of their functionality can be done by "transform".

Meteor.Collection.prototype.find = function (selector, options) {
  var result, userId = getUserId.call(this);

  selector = selector || {};

  if (delegate.call(this, "before", "find", userId, selector, options) !== false) {
    result = directFind.call(this, selector, options);
    delegate.call(this, "after", "find", userId, selector, options, result);
  }

  return result;
};

Meteor.Collection.prototype.findOne = function (selector, options) {
  var result, userId = getUserId.call(this);

  selector = selector || {};

  if (delegate.call(this, "before", "findOne", userId, selector, options) !== false) {
    result = directFindOne.call(this, selector, options);
    delegate.call(this, "after", "findOne", userId, selector, options, result);
  }

  return result;
};

Meteor.Collection.prototype.insert = function (doc, callback) {
  var result, userId = getUserId.call(this);

  if (delegate.call(this, "before", "insert", userId, doc, callback) !== false) {
    result = directInsert.call(this, doc, callback);
    delegate.call(this, "after", "insert", userId, result && this._collection.findOne({_id: result}) || doc, callback);
  }

  return result;
};

Meteor.Collection.prototype.update = function (selector, modifier, options, callback) {
  var result, previous, i, len, stopFiltering;
  var updateArgumentsRaw = Array.prototype.slice.call(arguments).reverse();
  var updateArguments = [];
  var userId = getUserId.call(this);

  selector = selector || {};

  if (delegate.call(this, "before", "update", userId, selector, modifier, options, callback) !== false) {
    previous = this._collection.find(selector, {reactive: false}).fetch();

    // Build an array of the parameters in preparation for Function.apply.
    // We can't use call here because of the way Meteor.Collection.update
    // resolves if the last parameter is a callback or not. If we use call,
    // and the caller didn't pass options, callbacks won't work. We need
    // to trim any undefined arguments off the end of the arguments array
    // that we pass.
    stopFiltering = false;
    for (i = 0, len = updateArgumentsRaw.length; i < len; i++) {
      // Skip undefined values until we hit a non-undefined value.
      // Then accept everything.
      if (stopFiltering || updateArgumentsRaw[i] !== undefined) {
        updateArguments.push(updateArgumentsRaw[i]);
        stopFiltering = true;
      }
    }

    updateArguments = updateArguments.reverse();

    result = directUpdate.apply(this, updateArguments);
    delegate.call(this, "after", "update", userId, selector, modifier, options, previous, callback);
  }

  return result;
};

Meteor.Collection.prototype.remove = function (selector, callback) {
  var result, previous, userId = getUserId.call(this);

  selector = selector || {};

  if (delegate.call(this, "before", "remove", userId, selector, callback) !== false) {
    previous = this._collection.find(selector, {reactive: false}).fetch();
    result = directRemove.call(this, selector, callback);
    delegate.call(this, "after", "remove", userId, selector, previous, callback);
  }

  return result;
};

if (Meteor.isServer) {
  (function () {

    var _validatedInsert = Meteor.Collection.prototype._validatedInsert;
    var _validatedUpdate = Meteor.Collection.prototype._validatedUpdate;
    var _validatedRemove = Meteor.Collection.prototype._validatedRemove;

    var directPublish = Meteor.publish;

    // Allow direct operations on server only. If they are allowed in
    // this form on the client, the validated versions will still run
    Meteor.Collection.prototype.directInsert = directInsert;
    Meteor.Collection.prototype.directUpdate = directUpdate;
    Meteor.Collection.prototype.directRemove = directRemove;

    // These are triggered on the server, but only when a client initiates
    // the method call. They act similarly to observes, but simply hi-jack
    // _validatedXXX. Additionally, they hi-jack the collection
    // instance's _collection.insert/update/remove temporarily in order to
    // maintain validator integrity (allow/deny).

    Meteor.Collection.prototype._validatedInsert = function (userId, doc) {
      var id, self = this;
      var _insert = self._collection.insert;

      self._collection.insert = function (doc) {
        if (delegate.call(self, "before", "insert", userId, doc) !== false) {
          id = _insert.call(this, doc);
          delegate.call(self, "after", "insert", userId, id && this.findOne({_id: id}) || doc);
        }
      };

      _validatedInsert.call(self, userId, doc);
      self._collection.insert = _insert;
    };

    Meteor.Collection.prototype._validatedUpdate = function (userId, selector, mutator, options) {
      var previous, self = this;
      var _update = self._collection.update;

      self._collection.update = function (selector, mutator, options) {
        if (delegate.call(self, "before", "update", userId, selector, mutator, options) !== false) {
          previous = this.find(selector).fetch();
          _update.call(this, selector, mutator, options);
          delegate.call(self, "after", "update", userId, selector, mutator, options, previous);
        }
      };

      _validatedUpdate.call(self, userId, selector, mutator, options);
      self._collection.update = _update;
    };

    Meteor.Collection.prototype._validatedRemove = function (userId, selector) {
      var previous, self = this;
      var _remove = self._collection.remove;

      self._collection.remove = function (selector) {
        if (delegate.call(self, "before", "remove", userId, selector, previous) !== false) {
          previous = this.find(selector).fetch();
          _remove.call(this, selector);
          delegate.call(self, "after", "remove", userId, selector, previous);
        }
      };

      _validatedRemove.call(self, userId, selector);
      self._collection.remove = _remove;
    };

    Meteor.publish = function (name, func) {
      return directPublish.call(this, name, function () {
        var result;

        Meteor.__collection_hooks_publish_userId = this.userId;
        result = func.apply(this, arguments);
        delete Meteor.__collection_hooks_publish_userId;

        return result;
      });
    };

  })();
}

Meteor.Collection.prototype.clearHooks = function (type, verb) {
  if (!this.__collection_hooks) this.__collection_hooks = {};
  if (!this.__collection_hooks[type]) this.__collection_hooks[type] = {};
  this.__collection_hooks[type][verb] = [];
};

_.each(["before", "after"], function (type) {
  Meteor.Collection.prototype[type] = function (verb, callback) {
    if (!this.__collection_hooks) this.__collection_hooks = {};
    if (!this.__collection_hooks[type]) this.__collection_hooks[type] = {};
    if (!this.__collection_hooks[type][verb]) this.__collection_hooks[type][verb] = [];

    this.__collection_hooks[type][verb].push(callback);
  };
});

if (Meteor.isClient) {
  Meteor.Collection.prototype.when = function (condition, callback) {
    var self = this;
    Deps.autorun(function (c) {
      if (condition.call(self._collection)) {
        c.stop();
        callback.call(self._collection);
      }
    });
  };
}
*/