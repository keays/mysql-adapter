/**
 * Module dependencies
 */
var mysql = require('mysql');
var jdb = require('jugglingdb');
var SqlString = require('./protocol/SqlString.js');

exports.initialize = function initializeSchema(schema, callback) {
    if (!mysql) return;

    var s = schema.settings;
    schema.pool = mysql.createPool({
        host: s.host || 'localhost',
        port: s.port || 3306,
        database: s.database,
        user: s.username,
        password: s.password,
        debug: s.debug,
        socketPath: s.socketPath,
        connectionLimit: s.connectionLimit || 10
    });

    schema.adapter = new MySQL(schema.pool);
    schema.adapter.schema = schema;

    // MySQL specific column types
    schema.constructor.registerType(function Point() {});

    callback();
};

/**
 * MySQL adapter
 */
function MySQL(pool) {
    this.name = 'mysql';
    this._models = {};
    this.pool = pool;
}

require('util').inherits(MySQL, jdb.BaseSQL);

MySQL.prototype.query = function (sql, callback) {
    this.pool.getConnection(function(poolErr, connection) {
        if(!poolErr) {
            var time = Date.now();
            var log = this.log;
            if (typeof callback !== 'function') throw new Error('callback should be a function');
            connection.query(sql, function (err, data) {
                if (log) log(sql, time);
                connection.end();
                callback(err, data);
            });
        }
        else {
            callback(poolErr);
        }
    });
};

/**
 * Must invoke callback(err, id)
 */
MySQL.prototype.create = function (model, data, callback) {
    var fields = this.toFields(model, data);
    var sql = 'INSERT INTO ' + this.tableEscaped(model);
    if (fields) {
        sql += ' SET ' + fields;
    } else {
        sql += ' VALUES ()';
    }
    this.query(sql, function (err, info) {
        callback(err, info && info.insertId);
    });
};

MySQL.prototype.updateOrCreate = function (model, data, callback) {
    var mysql = this;
    var fieldsNames = [];
    var fieldValues = [];
    var combined = [];
    var props = this._models[model].properties;
    Object.keys(data).forEach(function (key) {
        if (props[key] || key === 'id') {
            var k = '`' + key + '`';
            var v;
            if (key !== 'id') {
                v = mysql.toDatabase(props[key], data[key]);
            } else {
                v = data[key];
            }
            fieldsNames.push(k);
            fieldValues.push(v);
            if (key !== 'id') combined.push(k + ' = ' + v);
        }
    });

    var sql = 'INSERT INTO ' + this.tableEscaped(model);
    sql += ' (' + fieldsNames.join(', ') + ')';
    sql += ' VALUES (' + fieldValues.join(', ') + ')';
    sql += ' ON DUPLICATE KEY UPDATE ' + combined.join(', ');

    this.query(sql, function (err, info) {
        if (!err && info && info.insertId) {
            data.id = info.insertId;
        }
        callback(err, data);
    });
};

MySQL.prototype.toFields = function (model, data) {
    var fields = [];
    var props = this._models[model].properties;
    Object.keys(data).forEach(function (key) {
        if (props[key]) {
            var value = this.toDatabase(props[key], data[key]);
            if ('undefined' === typeof value) return;
            fields.push('`' + key.replace(/\./g, '`.`') + '` = ' + value);
        }
    }.bind(this));
    return fields.join(',');
};

function dateToMysql(val) {
    return val.getUTCFullYear() + '-' +
        fillZeros(val.getUTCMonth() + 1) + '-' +
        fillZeros(val.getUTCDate()) + ' ' +
        fillZeros(val.getUTCHours()) + ':' +
        fillZeros(val.getUTCMinutes()) + ':' +
        fillZeros(val.getUTCSeconds());

    function fillZeros(v) {
        return v < 10 ? '0' + v : v;
    }
}

MySQL.prototype.toDatabase = function (prop, val) {
    if (val === null) return 'NULL';
    if (val === undefined) return;
    if (val.constructor.name === 'Object') {
        var operator = Object.keys(val)[0]
        val = val[operator];
        if (operator === 'between') {
            return  this.toDatabase(prop, val[0]) +
                    ' AND ' +
                    this.toDatabase(prop, val[1]);
        } else if (operator == 'inq' || operator == 'nin') {
            if (!(val.propertyIsEnumerable('length')) && typeof val === 'object' && typeof val.length === 'number') { //if value is array
                for (var i = 0; i < val.length; i++) {
                    val[i] = SqlString.escape(val[i], false, this.pool.config.timezone);
                }
                return val.join(',');
            } else {
                return val;
            }
        }
    }
    if (!prop) return val;
    if (prop.type.name === 'Number') return Number(val);
    if (prop.type.name === 'Date') {
        if (!val) return 'NULL';
        if (!val.toUTCString) {
            val = new Date(val);
        }
        return '"' + dateToMysql(val) + '"';
    }
    if (prop.type.name == "Boolean") return val ? 1 : 0;
    return SqlString.escape(val.toString(), false, this.pool.config.timezone);
};

MySQL.prototype.fromDatabase = function (model, data) {
    if (!data) return null;
    var props = this._models[model].properties;
    Object.keys(data).forEach(function (key) {
        var val = data[key];
        if (typeof val === 'undefined' || val === null) {
            return;
        }
        if (props[key]) {
            switch(props[key].type.name) {
                case 'Date':
                    val = new Date(val.toString().replace(/GMT.*$/, 'GMT'));
                    break;
                case 'Boolean':
                    val = val == true ? true : false;
                    break;
            }
        }
        data[key] = val;
    });
    return data;
};

MySQL.prototype.escapeName = function (name) {
    return '`' + name.replace(/\./g, '`.`') + '`';
};

MySQL.prototype.all = function all(model, filter, callback) {

    var sql = 'SELECT * FROM ' + this.tableEscaped(model);
    var self = this;
    var props = this._models[model].properties;

    if (filter) {

        if (filter.where) {
            sql += ' ' + buildWhere(filter.where);
        }

        if (filter.order) {
            sql += ' ' + buildOrderBy(filter.order);
        }

        if (filter.limit) {
            sql += ' ' + buildLimit(filter.limit, filter.skip || 0);
        }

    }

    this.query(sql, function (err, data) {
        if (err) {
            return callback(err, []);
        }

        var objs = data.map(function (obj) {
            return self.fromDatabase(model, obj);
        });
        if (filter && filter.include) {
            this._models[model].model.include(objs, filter.include, callback);
        } else {
            callback(null, objs);
        }
    }.bind(this));

    return sql;

    function buildWhere(conds) {
        var cs = [];
        Object.keys(conds).forEach(function (key) {
            var keyEscaped = '`' + key.replace(/\./g, '`.`') + '`'
            var val = self.toDatabase(props[key], conds[key]);
            if (conds[key] === null || conds[key] === undefined) {
                cs.push(keyEscaped + ' IS NULL');
            } else if (conds[key] && conds[key].constructor.name === 'Object') {
                var condType = Object.keys(conds[key])[0];
                var sqlCond = keyEscaped;

                if(condType == 'custom') {
                    sqlCond = '';
                }

                if ((condType == 'inq' || condType == 'nin') && val.length == 0) {
                    cs.push(condType == 'inq' ? 0 : 1);
                    return true;
                }
                switch (condType) {
                    case 'gt':
                        sqlCond += ' > ';
                        break;
                    case 'gte':
                        sqlCond += ' >= ';
                        break;
                    case 'lt':
                        sqlCond += ' < ';
                        break;
                    case 'lte':
                        sqlCond += ' <= ';
                        break;
                    case 'between':
                        sqlCond += ' BETWEEN ';
                        break;
                    case 'inq':
                        sqlCond += ' IN ';
                        break;
                    case 'nin':
                        sqlCond += ' NOT IN ';
                        break;
                    case 'neq':
                        sqlCond += ' != ';
                        break;
                    case 'like':
                        sqlCond += ' LIKE ';
                        break;
                    case 'custom':
                        sqlCond += conds[key].custom;
                        break;
                }

                if(condType == 'inq' || condType == 'nin') {
                    sqlCond += '(' + val + ')';
                }
                else if(condType != 'custom') {
                    sqlCond += val;
                }

                cs.push(sqlCond);
            } else {
                cs.push(keyEscaped + ' = ' + val);
            }
        });
        if (cs.length === 0) {
          return '';
        }
        return 'WHERE ' + cs.join(' AND ');
    }

    function buildOrderBy(order) {
        if (typeof order === 'string') order = [order];
        return 'ORDER BY ' + order.map(function(o) {
            var t = o.split(/\s+/);
            if (t.length === 1) return '`' + o + '`';
            return '`' + t[0] + '` ' + t[1];
        }).join(', ');
    }

    function buildLimit(limit, offset) {
        return 'LIMIT ' + (offset ? (offset + ', ' + limit) : limit);
    }

};

MySQL.prototype.autoupdate = function (cb) {
    var self = this;
    var wait = 0;
    Object.keys(this._models).forEach(function (model) {
        wait += 1;
        self.query('SHOW FIELDS FROM ' + self.tableEscaped(model), function (err, fields) {
            self.query('SHOW INDEXES FROM ' + self.tableEscaped(model), function (err, indexes) {
                if (!err && fields.length) {
                    self.alterTable(model, fields, indexes, done);
                } else {
                    self.createTable(model, done);
                }
            });
        });
    });

    function done(err) {
        if (err) {
            console.log(err);
        }
        if (--wait === 0 && cb) {
            cb();
        }
    }
};

MySQL.prototype.isActual = function (cb) {
    var ok = false;
    var self = this;
    var wait = 0;
    Object.keys(this._models).forEach(function (model) {
        wait += 1;
        self.query('SHOW FIELDS FROM ' + model, function (err, fields) {
            self.query('SHOW INDEXES FROM ' + model, function (err, indexes) {
                self.alterTable(model, fields, indexes, done, true);
            });
        });
    });

    function done(err, needAlter) {
        if (err) {
            console.log(err);
        }
        ok = ok || needAlter;
        if (--wait === 0 && cb) {
            cb(null, !ok);
        }
    }
};

MySQL.prototype.alterTable = function (model, actualFields, actualIndexes, done, checkOnly) {
    var self = this;
    var m = this._models[model];
    var propNames = Object.keys(m.properties).filter(function (name) {
        return !!m.properties[name];
    });
    var indexNames = m.settings.indexes ? Object.keys(m.settings.indexes).filter(function (name) {
        return !!m.settings.indexes[name];
    }) : [];
    var sql = [];
    var ai = {};

    if (actualIndexes) {
        actualIndexes.forEach(function (i) {
            var name = i.Key_name;
            if (!ai[name]) {
                ai[name] = {
                    info: i,
                    columns: []
                };
            }
            ai[name].columns[i.Seq_in_index - 1] = i.Column_name;
        });
    }
    var aiNames = Object.keys(ai);

    // change/add new fields
    propNames.forEach(function (propName) {
        if (propName === 'id') return;
        var found;
        if (actualFields) {
            actualFields.forEach(function (f) {
                if (f.Field === propName) {
                    found = f;
                }
            });
        }

        if (found) {
            actualize(propName, found);
        } else {
            sql.push('ADD COLUMN `' + propName + '` ' + self.propertySettingsSQL(model, propName));
        }
    });

    // drop columns
    if (actualFields) {
        actualFields.forEach(function (f) {
            var notFound = !~propNames.indexOf(f.Field);
            if (f.Field === 'id') return;
            if (notFound || !m.properties[f.Field]) {
                sql.push('DROP COLUMN `' + f.Field + '`');
            }
        });
    }

    // remove indexes
    aiNames.forEach(function (indexName) {
        if (indexName === 'id' || indexName === 'PRIMARY') return;
        if (indexNames.indexOf(indexName) === -1 && !m.properties[indexName] || m.properties[indexName] && !m.properties[indexName].index) {
            sql.push('DROP INDEX `' + indexName + '`');
        } else {
            // first: check single (only type and kind)
            if (m.properties[indexName] && !m.properties[indexName].index) {
                // TODO
                return;
            }
            // second: check multiple indexes
            var orderMatched = true;
            if (indexNames.indexOf(indexName) !== -1) {
                m.settings.indexes[indexName].columns.split(/,\s*/).forEach(function (columnName, i) {
                    if (ai[indexName].columns[i] !== columnName) orderMatched = false;
                });
            }
            if (!orderMatched) {
                sql.push('DROP INDEX `' + indexName + '`');
                delete ai[indexName];
            }
        }
    });

    // add single-column indexes
    propNames.forEach(function (propName) {
        var i = m.properties[propName].index;
        if (!i) {
            return;
        }
        var found = ai[propName] && ai[propName].info;
        if (!found) {
            var type = '';
            var kind = '';
            if (i.type) {
                type = 'USING ' + i.type;
            }
            if (i.kind) {
                // kind = i.kind;
            }
            if (kind && type) {
                sql.push('ADD ' + kind + ' INDEX `' + propName + '` (`' + propName + '`) ' + type);
            } else {
                sql.push('ADD ' + kind + ' INDEX `' + propName + '` ' + type + ' (`' + propName + '`) ');
            }
        }
    });

    // add multi-column indexes
    indexNames.forEach(function (indexName) {
        var i = m.settings.indexes[indexName];
        var found = ai[indexName] && ai[indexName].info;
        if (!found) {
            var type = '';
            var kind = '';
            if (i.type) {
                type = 'USING ' + i.type;
            }
            if (i.kind) {
                kind = i.kind;
            }
            if (kind && type) {
                sql.push('ADD ' + kind + ' INDEX `' + indexName + '` (' + i.columns + ') ' + type);
            } else {
                sql.push('ADD ' + kind + ' INDEX ' + type + ' `' + indexName + '` (' + i.columns + ')');
            }
        }
    });

    if (sql.length) {
        var query = 'ALTER TABLE ' + self.tableEscaped(model) + ' ' + sql.join(',\n');
        if (checkOnly) {
            done(null, true, {statements: sql, query: query});
        } else {
            this.query(query, done);
        }
    } else {
        done();
    }

    function actualize(propName, oldSettings) {
        var newSettings = m.properties[propName];
        if (newSettings && changed(newSettings, oldSettings)) {
            sql.push('CHANGE COLUMN `' + propName + '` `' + propName + '` ' + self.propertySettingsSQL(model, propName));
        }
    }

    function changed(newSettings, oldSettings) {
        if (oldSettings.Null === 'YES' && (newSettings.allowNull === false || newSettings.null === false)) return true;
        if (oldSettings.Null === 'NO' && !(newSettings.allowNull === false || newSettings.null === false)) return true;
        if (oldSettings.Type.toUpperCase() !== datatype(newSettings)) return true;
        return false;
    }
};

MySQL.prototype.propertiesSQL = function (model) {
    var self = this;
    var sql = ['`id` INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY'];
    Object.keys(this._models[model].properties).forEach(function (prop) {
        if (prop === 'id') return;
        sql.push('`' + prop + '` ' + self.propertySettingsSQL(model, prop));
    });
    // Declared in model index property indexes.
    Object.keys(this._models[model].properties).forEach(function (prop) {
        var i = self._models[model].properties[prop].index;
        if (i) {
            sql.push(self.singleIndexSettingsSQL(model, prop));
        }
    });
    // Settings might not have an indexes property.
    var dxs = this._models[model].settings.indexes;
    if(dxs){
        Object.keys(this._models[model].settings.indexes).forEach(function(prop){
            sql.push(self.indexSettingsSQL(model, prop));
        });
    }
    return sql.join(',\n  ');
};

MySQL.prototype.singleIndexSettingsSQL = function (model, prop) {
    // Recycled from alterTable single indexes above, more or less.
    var i = this._models[model].properties[prop].index;
    var type = '';
    var kind = '';
    if (i.type) {
        type = 'USING ' + i.type;
    }
    if (i.kind) {
        kind = i.kind;
    }
    if (kind && type) {
        return (kind + ' INDEX `' + prop + '` (`' + prop + '`) ' + type);
    } else {
        return (kind + ' INDEX `' + prop + '` ' + type + ' (`' + prop + '`) ');
    }
};

MySQL.prototype.indexSettingsSQL = function (model, prop) {
    // Recycled from alterTable multi-column indexes above, more or less.
    var i = this._models[model].settings.indexes[prop];
    var type = '';
    var kind = '';
    if (i.type) {
        type = 'USING ' + i.type;
    }
    if (i.kind) {
        kind = i.kind;
    }
    if (kind && type) {
        return (kind + ' INDEX `' + prop + '` (' + i.columns + ') ' + type);
    } else {
        return (kind + ' INDEX ' + type + ' `' + prop + '` (' + i.columns + ')');
    }
};

MySQL.prototype.propertySettingsSQL = function (model, prop) {
    var p = this._models[model].properties[prop];
    return datatype(p) + ' ' +
    (p.allowNull === false || p['null'] === false ? 'NOT NULL' : 'NULL');
};

function datatype(p) {
    var dt = '';
    switch (p.type.name) {
        default:
        case 'String':
        case 'JSON':
        dt = 'VARCHAR(' + (p.limit || 255) + ')';
        break;
        case 'Text':
        dt = 'TEXT';
        break;
        case 'Number':
        dt = 'INT(' + (p.limit || 11) + ')';
        break;
        case 'Date':
        dt = 'DATETIME';
        break;
        case 'Boolean':
        dt = 'TINYINT(1)';
        break;
        case 'Point':
        dt = 'POINT';
        break;
    }
    return dt;
}

