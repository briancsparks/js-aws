
/**
 *
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');

var _                   = sg._;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var AwsJson             = awsJsonLib.AwsJson;
var die                 = sg.die;

var cf = {};

var awsCf = new aws.CloudFormation({region: 'us-east-1'});

cf.createStack = function(argv, context, callback) {
  var config = {};

  var options = {
    namespace     : argvGet(argv, 'namespace,ns'),
    classB        : argvGet(argv, 'class-b,classb')
  };

  var cfJson  = new awsJsonLib.CloudFormationJson(options);
  var vpc     = cfJson.vpc();

  vpc.cidrBlock(options.classB);
  vpc.enableDnsSupport();
  vpc.enableDnsHostnames();

  var subnetA = vpc.subnet('SubnetA', 'a');

  subnetA.cidrBlock(0, 0, 20);
  subnetA.mapPublicIpOnLaunch();

  var sgWide = vpc.securityGroup('sgWide');

  sgWide.groupDescription('For wide use');
  sgWide.ingress(-1, -1, -1, '10.0.0.0/8');
  sgWide.ingress('tcp', 22, 22, '0.0.0.0/0');

  // TODO: Remove hard-coded ids
  vpc.peeringConnection(0,  'vpc-523f3137', 'rtb-364fa452');
  vpc.peeringConnection(97, 'vpc-c1b4a6a5', 'rtb-d0fc77b7');

  config.TemplateBody = cfJson.toJson();
  config.StackName    = argvGet(argv, 'stack-name,stackname,aws-stack-name');

  return awsCf.createStack(config, function(err, stackResult) {
    if (err) { return die(err, callback, 'cf.createStack.createStack'); }

    return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));
  });
};

sg.exportify(module, cf);


