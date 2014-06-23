/****************************************************************************
 The MIT License (MIT)

 Copyright (c) 2013 Apigee Corporation

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
'use strict';

/*
 * This module implements the runtime SPI by talking to a proxy that is hosted inside Apigee.
 *
 * options:
 *   uri: The URI that your Apigee DNA Adapter is deployed to Apigee
 *   key: The API key for your adapter
 */

var url = require('url');
var http = require('http');
var https = require('https');
var querystring = require('querystring');
var OAuthCommon = require('volos-oauth-common');
var apigee = require('apigee-access');
var debug = require('debug')('apigee');
var _ = require('underscore');

var create = function(options) {
  var spi = new ApigeeRuntimeSpi(options);
  var oauth = new OAuthCommon(spi, options);
  return oauth;
};
module.exports.create = create;

var ApigeeRuntimeSpi = function(options) {
  if (!options.uri) {
    throw new Error('uri parameter must be specified');
  }
  if (!options.key) {
    throw new Error('key parameter must be specified');
  }

  this.uri = options.uri;
  this.key = options.key;

  this.oauth = new OAuthCommon(ApigeeRuntimeSpi, options);
};

/*
 * Generate an access token using client_credentials. Options:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   attributes: hash of custom attributes to store and retrieve with token
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
ApigeeRuntimeSpi.prototype.createTokenClientCredentials = function(options, cb) {
  var qs = {
    grant_type: 'client_credentials'
  };
  if (options.attributes) {
    qs.attributes = options.attributes;
  }
  if (options.scope) {
    qs.scope = options.scope;
  }
  var body = querystring.stringify(qs);
  options.grantType = 'client_credentials';
  makeRequest(this, 'POST', '/tokentypes/client/tokens',
    body, options, function(err, result) {
      cb(err, result);
    });
};

function setFlowVariables(req, resp) {
  if (!req) { return; }
  var keys = Object.keys(resp.headers);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.indexOf('x-v.') === 0) {
      var varName = key.substring(4);
      if (resp.headers[key].length) {
        apigee.setVariable(req, varName, resp.headers[key]);
        if (debug.enabled) { debug('VAR: ' + varName + ' = ' + resp.headers[key]); }
      }
    }
  }
}

/*
 * Generate an access token using password credentials. Options:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   username: required but not checked (must be checked outside this module)
 *   password: required by not checked (must be checked outside this module)
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
ApigeeRuntimeSpi.prototype.createTokenPasswordCredentials = function(options, cb) {
  var qs = {
    grant_type: 'password',
    username: options.username,
    password: options.password
  };
  if (options.attributes) {
    qs.attributes = options.attributes;
  }
  if (options.scope) {
    qs.scope = options.scope;
  }
  var body = querystring.stringify(qs);
  options.grantType = 'password';
  makeRequest(this, 'POST', '/tokentypes/password/tokens',
    body, options, function(err, result) {
      cb(err, result);
    });
};

/*
 * Generate an access token for authorization code once a code has been set up. Options:
 *   clientId: required
 *   clientSecret: required
 *   code: Authorization code already generated by the "generateAuthorizationCode" method
 *   redirectUri: The same redirect URI that was set in the call to generate the authorization code
 *   tokenLifetime: lifetime in milliseconds, optional
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
ApigeeRuntimeSpi.prototype.createTokenAuthorizationCode = function(options, cb) {
  var qs = {
    grant_type: 'authorization_code',
    code: options.code
  };
  if (options.redirectUri) {
    qs.redirect_uri = options.redirectUri;
  }
  if (options.clientId) {
    qs.client_id = options.clientId;
  }
  var body = querystring.stringify(qs);
  options.grantType = 'authorization_code';
  makeRequest(this, 'POST', '/tokentypes/authcode/tokens',
    body, options, function(err, result) {
      // todo: fix at source (spec p. 45)
      if (err) {
        if (err.message === 'Invalid Authorization Code' || err.message === 'Required param : redirect_uri') {
          err.code = 'invalid_grant';
        } else if (/^Invalid redirect_uri :/.test(err.message)) {
          err.code = 'invalid_grant';
        }
      }
      cb(err, result);
    });
};

/*
 * Generate a redirect response for the authorization_code grant type. Options:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 */
ApigeeRuntimeSpi.prototype.generateAuthorizationCode = function(options, cb) {
  var qs = {
    response_type: 'code',
    client_id: options.clientId
  };
  if (options.redirectUri) {
    qs.redirect_uri = options.redirectUri;
  }
  if (options.scope) {
    qs.scope = options.scope;
  }
  if (options.state) {
    qs.state = options.state;
  }

  makeGetRequest(this, '/tokentypes/authcode/authcodes', querystring.stringify(qs),
                 options, function(err, result) {
    cb(err, result);
  });
};

/*
 * Generate a redirect response for the implicit grant type. Options:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 */
ApigeeRuntimeSpi.prototype.createTokenImplicitGrant = function(options, cb) {
  var qs = {
    response_type: 'token',
    client_id: options.clientId
  };
  if (options.attributes) {
    qs.attributes = options.attributes;
  }
  if (options.redirectUri) {
    qs.redirect_uri = options.redirectUri;
  }
  if (options.scope) {
    qs.scope = options.scope;
  }
  if (options.state) {
    qs.state = options.state;
  }

  makeGetRequest(this, '/tokentypes/implicit/tokens', querystring.stringify(qs),
                 options, function(err, result) {
    cb(err, result);
  });
};

/*
 * Refresh an existing access token, and return a new token. Options:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: required, from the original token grant
 *   scope: optional
 */
ApigeeRuntimeSpi.prototype.refreshToken = function(options, cb) {
  var qs = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken
  };
  if (options.scope) {
    qs.scope = options.scope;
  }
  var body = querystring.stringify(qs);
  options.grantType = 'refresh_token';
  makeRequest(this, 'POST', '/tokentypes/all/refresh',
    body, options, function(err, result) {
      // todo: fix at source (spec p. 45)
      if (err && err.message === 'Invalid Scope') {
        err.code = 'invalid_scope';
      }
      cb(err, result);
    });
};

/*
 * Invalidate an existing token. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: either this or accessToken must be specified
 *   accessToken: same
 */
ApigeeRuntimeSpi.prototype.invalidateToken = function(options, cb) {
  var qs = {
    token: options.token
  };
  if (options.tokenTypeHint) {
    qs.tokenTypeHint = options.tokenTypeHint;
  }
  var body = querystring.stringify(qs);

  makeRequest(this, 'POST', '/tokentypes/all/invalidate',
    body, options, function(err, result) {
      cb(err, result);
    });
};

/*
 * Validate an access token.
 */
ApigeeRuntimeSpi.prototype.verifyToken = function(token, requiredScopes, cb) {
  var urlString = this.uri + '/tokentypes/all/verify';
  if (requiredScopes) {
    urlString = urlString + '?' + querystring.stringify({ scope: requiredScopes });
  }
  var r = url.parse(urlString);
  r.headers = {
    Authorization: 'Bearer ' + token
  };
  r.headers['x-DNA-Api-Key'] = this.key;
  r.method = 'GET';

  var requestor;
  if (r.protocol === 'http:') {
    requestor = http;
  } else if (r.protocol === 'https:') {
    requestor = https;
  } else {
    cb(new Error('Unsupported protocol ' + r.protocol));
    return;
  }

  var req = requestor.request(r, function(resp) {
    verifyRequestComplete(resp, requiredScopes, cb);
  });

  req.on('error', function(err) {
    cb(err);
  });
  req.end();
};

function makeRequest(self, verb, uriPath, body, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = undefined;
  }

  var finalUri = self.uri + uriPath;

  var r = url.parse(finalUri);
  r.headers = {
    Authorization: 'Basic ' + new Buffer(options.clientId + ':' + options.clientSecret).toString('base64')
  };
  r.headers['x-DNA-Api-Key'] = self.key;
  if (options.tokenLifetime) {
    r.headers['x-DNA-Token-Lifetime'] = options.tokenLifetime;
  }
  if (options.attributes) {
    r.headers['x-DNA-Token-Attributes'] = JSON.stringify(options.attributes);
  }
  r.method = verb;
  if (body) {
    r.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  var requestor;
  if (r.protocol === 'http:') {
    requestor = http;
  } else if (r.protocol === 'https:') {
    requestor = https;
  } else {
    cb(new Error('Unsupported protocol ' + r.protocol));
    return;
  }

  var req = requestor.request(r, function(resp) {
    requestComplete(resp, options, function() {
      setFlowVariables(options.request, resp);
      cb.apply(this, arguments);
    });
  });

  req.on('error', function(err) {
    cb(err);
  });
  if (body) {
    req.end(body);
  } else {
    req.end();
  }
}

function makeGetRequest(self, uriPath, qs, options, cb) {
  var finalUri = self.uri + uriPath + '?' + qs;

  var r = url.parse(finalUri);
  r.headers = {};
  r.headers['x-DNA-Api-Key'] = self.key;
  r.method = 'GET';

  if (debug.enabled) {
    debug('GET ' + finalUri);
  }

  var requestor;
  if (r.protocol === 'http:') {
    requestor = http;
  } else if (r.protocol === 'https:') {
    requestor = https;
  } else {
    cb(new Error('Unsupported protocol ' + r.protocol));
    return;
  }

  var req = requestor.request(r, function(resp) {
    getRequestComplete(resp, options, function() {
      setFlowVariables(options.request, resp);
      cb.apply(this, arguments);
    });
  });

  req.on('error', function(err) {
    cb(err);
  });
  req.end();
}

function readResponse(resp, data) {
  var d;
  do {
    d = resp.read();
    if (d) {
      data += d;
    }
  } while (d);
  return data;
}

function requestComplete(resp, options, cb) {
  resp.on('error', function(err) {
    cb(err);
  });

  var respData = '';
  resp.on('readable', function() {
    respData = readResponse(resp, respData);
  });

  resp.on('end', function() {
    if (resp.statusCode >= 300) {
      var err = new Error('Error on HTTP request');
      err.statusCode = resp.statusCode;
      if (resp.statusCode === 400 || resp.statusCode === 401) { // oauth return
        var ret = JSON.parse(respData);
        if (ret.ErrorCode !== null) {
          err.code = ret.ErrorCode;
          err.message = ret.Error;
        }
      } else {
        err.message = respData;
      }
      cb(err);
    } else {
      var json;
      try {
        json = JSON.parse(respData);
        if (json.expires_in) {
          json.expires_in = parseInt(json.expires_in, 10);
        }
        if (options.grantType) {
          json.token_type = options.grantType;
        }
        if (json.attributes) {
          json.attributes = JSON.parse(json.attributes);
        }
      } catch (e) {
        // The response might not be JSON -- not everything returns it
        return cb();
      }
      cb(undefined, json);
    }
  });
}

function getRequestComplete(resp, options, cb) {
  resp.on('error', function(err) {
    cb(err);
  });

  var respData = '';
  resp.on('readable', function() {
    respData = readResponse(resp, respData);
  });

  resp.on('end', function() {
    if (resp.statusCode !== 302) {
      var err = new Error('Error on HTTP request');
      err.statusCode = resp.statusCode;
      err.message = respData;
      cb(err);
    } else {
      cb(undefined, resp.headers.location);
    }
  });
}

function verifyRequestComplete(resp, requiredScopes, cb) {
  resp.on('error', function(err) {
    cb(err);
  });

  var respData = '';
  resp.on('readable', function() {
    respData = readResponse(resp, respData);
  });

  resp.on('end', function() {
    var err;
    if (resp.statusCode !== 200) {
      err = new Error('Error on HTTP request');
      err.statusCode = resp.statusCode;
      err.message = respData;
      cb(err);
    } else {
      if (cb) {
        // todo: this can be removed when Apigee Edge can process scopes passed up to it
        var parsed = querystring.parse(respData);
        if (!Array.isArray(requiredScopes)) {
          requiredScopes = requiredScopes ? requiredScopes.split(' ') : [];
        }
        var grantedScopes = parsed.scope ? parsed.scope.split(' ') : [];
        if (_.difference(requiredScopes, grantedScopes).length > 0) {
          err = new Error('invalid_scope');
          err.errorCode = 'invalid_scope';
          return cb(err);
        }
        if (parsed.attributes) { parsed.attributes = JSON.parse(parsed.attributes); }
        cb(undefined, parsed);
      }
    }
  });
}
