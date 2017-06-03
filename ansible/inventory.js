
/**
 *
 */
var sg              = require('sgsg');
var _               = sg._;
var ARGV            = sg.ARGV();
var fs              = require('fs');
var jsawsEc2        = require('../lib2/ec2/ec2.js');

var main = function() {
  if (ARGV.setup) { return lib.setup({}, {}, function(){}); }

  // Ansible will call with --list or --host
  if (ARGV.host)  { process.stdout.write('{}\n'); }

  if (ARGV.list)  {
    lib.inventory({}, {}, function(err, list) {
      process.stdout.write(JSON.stringify(list)+"\n");
    });
  }
};

var lib = {};

/**
 *  Setup this machine to use js-aws with Ansible.
 */
lib.setup = function(argv, context, callback) {
  scriptBody = sg.lines(
    "#!/bin/bash -e",
    "ra invoke "+__filename+" inventory",
    ""
  );

  try {
    fs.writeFileSync('/etc/ansible/hosts', scriptBody);
    fs.chmodSync('/etc/ansible/hosts', 0755);
  } catch(e) {
    console.error(e);
    console.error('\n\ntry sudo !!');
    return process.exit(e.errno);
  }
};

/**
 *  Return a JSON object in the Ansible format for our current
 *  server inventory, and vars. As documented here:
 *
 *          http://docs.ansible.com/ansible/dev_guide/developing_inventory.html
 *
 */
lib.inventory = function(argv, context, callback) {
  return jsawsEc2.getInstances({}, context, function(err, instances_) {
    var result = sg.reduce(instances_, {}, function(m_, instance, instanceId) {
      var m = m_;
      //var instData = _.pick(instance, 'PrivateIpAddress', 'Tags');
      var instData = instance.PrivateIpAddress;
      var b        = instance.PrivateIpAddress.split('.')[1];

      if (!instance.Tags)     { return m; }

      // This server belongs to all the groups for which it has tags
      _.each(instance.Tags, function(value, tag) {
        if (tag.startsWith('aws'))          { return; }
        if (tag.toLowerCase() === 'name')   { return; }
        if (!_.isString(value))             { return; }
        if (value.match(/^[0-9]+$/))        { return; }

        var v = value.replace(/[^a-zA-Z0-9]/g, '_');
        if (!m[v] || (_.isString(instData) && m[v] && (m[v].hosts.indexOf(instData) === -1))) {
          sg.setOnna(m, [v, 'hosts'], instData);
        }
      });

      // Then, add bXX
      sg.setOnna(m, ['b'+b, 'hosts'], instData);

      return m;
    });

    result._meta = { hostvars: {}};
    return callback(null, result);
  });
};

/**
 *  Return a JSON object in the Ansible format for our current
 *  server inventory, and vars. As documented here:
 *
 *          http://docs.ansible.com/ansible/dev_guide/developing_inventory.html
 *
 */
lib.inventoryX = function(argv, context, callback) {
  var result = {};

  var parts;
  var accts = process.env.JSAWS_AWS_ACCT_EXTRA_CREDS.split(',');
  accts.push('dev');

  var d = {
    instances: {}
  };

  return sg.__runll([function(next) {
    // Get instances
    return sg.__eachll(accts, function(acct, nextAcct) {

      // acct is 'prod:123456789012/projc-yournamehere' or 'dev'
      parts = acct.split(':');
      var name  = parts[0];
      var iam   = parts[1];

      return jsawsEc2.getInstances({}, context, function(err, instances_) {
        d.instances[name] = instances_;
        return nextAcct();
      });
    }, function() {
      return next();
    });
  }], function() {
    result.d = d;
    return callback(null, result);
  });
};

if (process.argv[1] === __filename) {
  main();
}

_.each(lib, function(value, key) {
  exports[key] = value;
});

