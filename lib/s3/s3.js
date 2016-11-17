
/**
 *  JS-ification of S3.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');

var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var deref               = sg.deref;

var raS3;                /* Gets build from the libEc2 object at the end of this file */

var libS3          = {};

/**
 *
 */
libS3.putObject = function(argv, context, callback) {
  argv                        = jsaws.prep(argv);
  var awsS3                   = jsaws.getS3(argv);

  var extension               = argvExtract(argv, 'extension,ext');
  var contentType             = argvExtract(argv, 'content-type,contenttype,ct');
  var key                     = argvExtract(argv, 'key');
  var body                    = argvExtract(argv, 'body');

  var prefix, name;

  if (extension && extension[0] !== '.') {
    extension = '.'+extension;
  }

  if (!key) {
    prefix                    = argvExtract(argv, 'prefix');
    name                      = argvExtract(argv, 'filename,name');

    if (prefix && name) {
      key = [prefix, name].join('/') + (extension || '');
    }
  }

  if (sg.isObject(body)) {
    body = JSON.stringify(body, null, 2);
  }

  var s3PutParams             = {};
  s3PutParams.Bucket          = argvExtract(argv, 'bucket');
  s3PutParams.ContentType     = contentType || sg.mimeType(extension)          || 'application/octet-stream';
  s3PutParams.Key             = key;
  s3PutParams.Body            = body;

  return awsS3.putObject(s3PutParams, function(err, data) {
    if (err)  { return die(err, callback, 's3.putObject.putObject'); }

    var result      = _.extend({_params:_.omit(s3PutParams, 'Body')}, data);
    result.s3Url    = ['s3:/', s3PutParams.Bucket, s3PutParams.Key].join('/');
    result.httpUrl  = ['https://s3.amazonaaws.com', s3PutParams.Bucket, s3PutParams.Key].join('/');
    return callback(err, result);
  });
};


raS3 = ra.wrap(libS3);
_.each(libS3, function(value, key) {
  exports[key] = value;
});




