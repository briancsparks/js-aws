
/**
 *
 */

var sg              = require('sgsg');
var _               = sg._;
var http            = require('http');
var urlLib          = require('url');
var jsaws           = require('./jsaws');


http.createServer(function(req, res) {
  var url       = urlLib.parse(req.url, true);
  var pathname  = url.pathname;

  return sg.getBody(req, function(err, body) {
    if (err) { return sg._400(req, res, {}); }

    var parts = _.rest(pathname.split('/'));
    if (parts.length < 2)   { return sg._400(req, res, sg.toError('need /api/fname')); }

    var fname = parts[1];
    var args  = _.extend({name:fname}, _.pick(body, 'args'));

    if (parts[0] === 'ec2') {
      return jsaws.ec2Describe(args, {}, function(err, data) {
        if (err) { return sg._400(req, res, sg.toError('error calling '+fname)); }
        return sg._200(req, res, data);
      });
    } else if (parts[0] === 'route53') {
      return jsaws.r53Describe(args, {}, function(err, data) {
        if (err) { return sg._400(req, res, sg.toError('error calling '+fname)); }
        return sg._200(req, res, data);
      });
    } else if (parts[0] === 'sns') {
      return jsaws.snsDescribe(args, {}, function(err, data) {
        if (err) { return sg._400(req, res, sg.toError('error calling '+fname)); }
        return sg._200(req, res, data);
      });
    }
  });

}).listen(21234);


