
/**
 *  The js-aws version of the AWS SNS API.
 *
 *  Conforms to the run-anywhere calling convention.
 *
 *
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var raSns;

var die                 = sg.die;
var argvGet             = sg.argvGet;

libSns = {};

/**
 *  Publish to an SNS topic.
 *
 *    ra invoke lib/sns/sns.js publish --topic= --subject= --message=
 */
libSns.publish = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsSns        = jsaws.getSns(argv);

  var message       = argvGet(argv, 'message,msg');
  var json          = argvGet(argv, 'json');

  var params = {
    TopicArn    : argvGet(argv, 'topic'),
    Subject     : argvGet(argv, 'subject')
  };

  if (message)    { params.Message = message; }
//  if (json)       { params.Message = JSON.stringify({a:42}); params.MessageStructure = 'json'; }

  return jsaws.envInfo({}, {}, function(err, env) {
    return raSns.listTopics({}, context, function(err, topics) {
      var matchingArns = [];
      if (params.TopicArn.split(':').length < 3) {
        _.each(topics.Topics, function(obj) {
          var value = obj.TopicArn;
          if (value.indexOf(params.TopicArn) !== -1) {
            matchingArns.push(value);
          }
        });

        if (matchingArns.length === 0) {
          return callback(sg.toError('Error in sns.publish: no matching arns'));
        } else if (matchingArns.length > 1) {
          return callback(sg.toError('Error in sns.publish: ambiguous TopicArns: '+matchingArns.join(',')));
        }

        params.TopicArn = matchingArns[0];
      }

      return awsSns.publish(params, function(err, result) {
        if (err) { return die(err, callback, 'sns.publish.publish'); }

        return callback(null, result);
      });
    });
  });
};

libSns.listTopics = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsSns        = jsaws.getSns(argv);

  awsSns.listTopics({}, function(err, topics) {
    return callback(err, topics);
  });
};

libSns.awsEnumerators = function() {
  return {
    all: {
      "SNS::Topic"  : libSns.listTopics
    }
  };
};

raSns = ra.wrap(libSns);

_.each(libSns, function(value, key) {
  exports[key] = value;
});

