
var sg              = require('sgsg');
var _               = sg._;
var urlLib          = require('url');

var express         = require('express');
var router          = express.Router();
var awsData         = require('../aws-data');

// Logger
var mkDebug         = require('debug');
var debug           = mkDebug('aws-socket');

var doAwsApi;

router.get('/awsapi/:awsApi', function(req, res) {
  debug("req: %s", req.url);

  var url = urlLib.parse(req.url, true);

  var query = sg.deepCopy(url.query);
//  query.skipEmit = true;

  var accts      = jsaws.getAcct('pub', process.env.JSAWS_AWS_ACCT_EXTRA_CREDS);
  accts.session  = 'prod';

  return doAwsApi(req.params.awsApi, query, {accounts:accts}, function(err, result) {
    if (err) { res.status(404).json(err); return; }

    res.json(result);
  });
});

doAwsApi = function(apiName, query, body, callback) {
  return awsData.dispatch(apiName, sg.deref(body, 'accounts') || {}, query, function(err, data) {
    if (err) { return callback(err); }
    return callback(null, data);
  });
};

module.exports = router;

