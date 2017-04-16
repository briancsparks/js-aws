
/**
 *  All things JavaScript-ifying xray.
 */
var sg              = require('sgsg');
var _               = sg._;
var AWSXRay         = require('aws-xray-sdk');
var nginx           = require('nginx-json/subrequest');

var mwUtils         = AWSXRay.middleware;

var xray = {};

// options.service,ip,port,root,parent,sampled
xray.balanceTo = function(req, res, path, options_) {
  var amznTraceHeader   = mwUtils.processHeaders(req);
  var options           = _.extend({}, options_ || {});

  options.root    = amznTraceHeader.Root    || options.root;
  options.parent  = amznTraceHeader.Parent  || options.parent;
  options.sampled = amznTraceHeader.Sampled || options.sampled;

  // If we still do not have a root, make one
  if (!options.root) {
    options.root = "1-"+sg.randomString(8, sg.hexCharSet)+'-'+sg.randomString(24, sg.hexCharSet);
  }

  // Fixup sampled
  if (!('sampled' in options)) {
    options.sampled = 0;
  } else if (options.sampled === true) {
    options.sampled = 1;
  } else if (options.sampled === false) {
    options.sampled = 0;
  }

  nginx.instrumentedBalanceTo(req, res, path, options);
};

_.each(xray, function(value, key) {
  exports[key] = value;
});

