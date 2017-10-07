
/**
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const awsServiceLib           = require('../lib/service/service');

const awsService              = awsServiceLib.awsService;
const argvExtract             = sg.argvExtract;
const setOn                   = sg.setOn;

const arNames                 = 'OwnerIds,Owners'.split(',');

var lib = {};

lib.ec2 = function(argv, context, callback) {
  const acct    = argvExtract(argv, 'acct');
  const iam     = argvExtract(argv, 'iam');
  const fname   = argvExtract(argv, 'function,fn,f');
  var   argv2   = sg.deepCopy(argv);

  const awsEc2  = service('EC2', sg.extend({acct}, {iam}));

  arrayify(argv2, argv, arNames);

  awsEc2[fname](argv2, (err, data) => {
    return callback(err, data);
  });
};



_.each(lib, (value, key) => {
  exports[key] = value;
});

function arrayify(argv2, argv, names) {
  _.each(names, name => {
    setOn(argv2, name, (name in argv)? [argv[name]] : null);
  });
}

function service(name, argv) {
  if (argv.acct)            { return awsService(name, {acct:argv.acct}); }
  else if (argv.iam)        { return awsService(name, {iam:argv.iam}); }

  return awsService(name, awsServiceLib.extractServiceArgs({}));
}

