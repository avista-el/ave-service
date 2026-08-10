// Initialise the replica set required for multi-document transactions.
// This script runs once when the MongoDB container starts for the first time.
rs.initiate({
  _id: 'rs0',
  members: [{ _id: 0, host: 'mongo:27017' }],
});
