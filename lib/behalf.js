
/**
 *
 */

var sg                  = require('sgsg');
var _                   = sg._;
var ra                  = require('run-anywhere');
var http                = require('http');
var util                = require('util');
var aws                 = require('aws-sdk');
var superagent          = require('superagent');
var urlLib              = require('url');
var jsaws               = require('js-aws');
var Router              = require('routes');
var router              = Router();

// Lower-case-ify aws objects
_.each(aws, function(value, key) {
  if (!_.isFunction(value))           { /* console.error(key+' is not a function'); */ }
  else {
    var lc = key.toLowerCase();
    if (lc in aws)                    { /* console.error(lc+' is already in aws.'); */ }
    else {
      aws[lc] = value;
    }
  }
});

var cachedAws = {};

var fulfill = ra.routesify(function(rr, context, callback) {

  var remoteAddress = rr.req.connection.remoteAddress;
  if (!remoteAddress.match(/10\.11\.0\.25[0-9]/))   { console.log('Denying: '+remoteAddress); return sg._403(rr.req, rr.res);  }

  var query     = {};
  var awsArgs   = [];
  return sg.__run([function(next) {
    return sg.getBody(rr.req, function(err, body_) {
      if (err) { return sg.die(err, callback, 'behalf.fulfill.getBody'); }

      var body = body_ || {};

      if (_.isArray(body))          { awsArgs = _.toArray(body); }
      else                          { awsArgs = [body]; }

      if (_.isObject(awsArgs[0])) {
        _.extend(awsArgs[0], urlLib.parse(rr.req.url, true).query);
      }

      return next();
    });
  }], function() {
    awsArgs.push(function(err, data) {
      console.log(rr.params.awsApi+'.'+rr.params.awsFn+'(); Error: '+err+'; size: '+JSON.stringify(data).length);
      if (err) { return sg.die(err, callback, 'behalf.fulfill.[awsApi]'); }

      return sg._200(rr.req, rr.res, data);
    });

    var service = awsService(rr.params.awsApi);
    service[rr.params.awsFn].apply(service, awsArgs);

  });

});


var main = function() {

  router.addRoute('/:awsApi/:awsFn', fulfill);
  router.addRoute('/:awsApi/:awsFn/*', fulfill);

  http.createServer(function (req, res) {
    //console.log("matching", req.url);
    var path  = urlLib.parse(req.url).pathname;
    var match = router.match(path);

    //console.log("matched", match);

    if (match) {
      return match.fn(req, res, match);
    }

    return sg._404(req, res);

  }).listen(21235);
};




main();

function awsService(name_) {
  var name = name_.toLowerCase();

  if (!cachedAws[name]) {
    cachedAws[name] = new aws[name]({region: 'us-east-1'});
  }

  return cachedAws[name];
}


