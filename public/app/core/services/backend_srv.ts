import _ from 'lodash';
import coreModule from 'app/core/core_module';
import appEvents from 'app/core/app_events';
import { DashboardModel } from 'app/features/dashboard/dashboard_model';

export class BackendSrv {
  private inFlightRequests = {};
  private HTTP_REQUEST_CANCELLED = -1;
  private noBackendCache: boolean;

  /** @ngInject */
  constructor(private $http, private alertSrv, private $q, private $timeout, private contextSrv) {}

  get(url, params?) {
    return this.request({ method: 'GET', url: url, params: params });
  }

  delete(url) {
    return this.request({ method: 'DELETE', url: url });
  }

  post(url, data) {
    return this.request({ method: 'POST', url: url, data: data });
  }

  patch(url, data) {
    return this.request({ method: 'PATCH', url: url, data: data });
  }

  put(url, data) {
    return this.request({ method: 'PUT', url: url, data: data });
  }

  withNoBackendCache(callback) {
    this.noBackendCache = true;
    return callback().finally(() => {
      this.noBackendCache = false;
    });
  }

  requestErrorHandler(err) {
    if (err.isHandled) {
      return;
    }

    var data = err.data || { message: 'Unexpected error' };
    if (_.isString(data)) {
      data = { message: data };
    }

    if (err.status === 422) {
      this.alertSrv.set('Validation failed', data.message, 'warning', 4000);
      throw data;
    }

    data.severity = 'error';

    if (err.status < 500) {
      data.severity = 'warning';
    }

    if (data.message) {
      let description = '';
      let message = data.message;
      if (message.length > 80) {
        description = message;
        message = 'Error';
      }
      this.alertSrv.set(message, description, data.severity, 10000);
    }

    throw data;
  }

  request(options) {
    options.retry = options.retry || 0;
    var requestIsLocal = !options.url.match(/^http/);
    var firstAttempt = options.retry === 0;

    if (requestIsLocal) {
      if (this.contextSrv.user && this.contextSrv.user.orgId) {
        options.headers = options.headers || {};
        options.headers['X-Grafana-Org-Id'] = this.contextSrv.user.orgId;
      }

      if (options.url.indexOf('/') === 0) {
        options.url = options.url.substring(1);
      }
    }

    return this.$http(options).then(
      results => {
        if (options.method !== 'GET') {
          if (results && results.data.message) {
            if (options.showSuccessAlert !== false) {
              this.alertSrv.set(results.data.message, '', 'success', 3000);
            }
          }
        }
        return results.data;
      },
      err => {
        // handle unauthorized
        if (err.status === 401 && this.contextSrv.user.isSignedIn && firstAttempt) {
          return this.loginPing().then(() => {
            options.retry = 1;
            return this.request(options);
          });
        }

        this.$timeout(this.requestErrorHandler.bind(this, err), 50);
        throw err;
      }
    );
  }

  addCanceler(requestId, canceler) {
    if (requestId in this.inFlightRequests) {
      this.inFlightRequests[requestId].push(canceler);
    } else {
      this.inFlightRequests[requestId] = [canceler];
    }
  }

  resolveCancelerIfExists(requestId) {
    var cancelers = this.inFlightRequests[requestId];
    if (!_.isUndefined(cancelers) && cancelers.length) {
      cancelers[0].resolve();
    }
  }

  datasourceRequest(options) {
    options.retry = options.retry || 0;

    // A requestID is provided by the datasource as a unique identifier for a
    // particular query. If the requestID exists, the promise it is keyed to
    // is canceled, canceling the previous datasource request if it is still
    // in-flight.
    var requestId = options.requestId;
    if (requestId) {
      this.resolveCancelerIfExists(requestId);
      // create new canceler
      var canceler = this.$q.defer();
      options.timeout = canceler.promise;
      this.addCanceler(requestId, canceler);
    }

    var requestIsLocal = !options.url.match(/^http/);
    var firstAttempt = options.retry === 0;

    if (requestIsLocal) {
      if (this.contextSrv.user && this.contextSrv.user.orgId) {
        options.headers = options.headers || {};
        options.headers['X-Grafana-Org-Id'] = this.contextSrv.user.orgId;
      }

      if (options.url.indexOf('/') === 0) {
        options.url = options.url.substring(1);
      }

      if (options.headers && options.headers.Authorization) {
        options.headers['X-DS-Authorization'] = options.headers.Authorization;
        delete options.headers.Authorization;
      }

      if (this.noBackendCache) {
        options.headers['X-Grafana-NoCache'] = 'true';
      }
    }

    return this.$http(options)
      .then(response => {
        appEvents.emit('ds-request-response', response);
        return response;
      })
      .catch(err => {
        if (err.status === this.HTTP_REQUEST_CANCELLED) {
          throw { err, cancelled: true };
        }

        // handle unauthorized for backend requests
        if (requestIsLocal && firstAttempt && err.status === 401) {
          return this.loginPing().then(() => {
            options.retry = 1;
            if (canceler) {
              canceler.resolve();
            }
            return this.datasourceRequest(options);
          });
        }

        // populate error obj on Internal Error
        if (_.isString(err.data) && err.status === 500) {
          err.data = {
            error: err.statusText,
            response: err.data,
          };
        }

        // for Prometheus
        if (err.data && !err.data.message && _.isString(err.data.error)) {
          err.data.message = err.data.error;
        }

        appEvents.emit('ds-request-error', err);
        throw err;
      })
      .finally(() => {
        // clean up
        if (options.requestId) {
          this.inFlightRequests[options.requestId].shift();
        }
      });
  }

  loginPing() {
    return this.request({ url: '/api/login/ping', method: 'GET', retry: 1 });
  }

  search(query) {
    return this.get('/api/search', query);
  }

  getDashboard(type, slug) {
    return this.get('/api/dashboards/' + type + '/' + slug);
  }

  saveDashboard(dash, options) {
    options = options || {};

    return this.post('/api/dashboards/db/', {
      dashboard: dash,
      folderId: options.folderId,
      overwrite: options.overwrite === true,
      message: options.message || '',
    });
  }

  createDashboardFolder(name) {
    const dash = {
      schemaVersion: 16,
      title: name.trim(),
      editable: true,
      panels: [],
    };

    return this.post('/api/dashboards/db/', {
      dashboard: dash,
      isFolder: true,
      overwrite: false,
    }).then(res => {
      return this.getDashboard('db', res.slug);
    });
  }

  deleteDashboard(slug) {
    let deferred = this.$q.defer();

    this.getDashboard('db', slug).then(fullDash => {
      this.delete(`/api/dashboards/db/${slug}`)
        .then(() => {
          deferred.resolve(fullDash);
        })
        .catch(err => {
          deferred.reject(err);
        });
    });

    return deferred.promise;
  }

  deleteDashboards(dashboardSlugs) {
    const tasks = [];

    for (let slug of dashboardSlugs) {
      tasks.push(this.createTask(this.deleteDashboard.bind(this), true, slug));
    }

    return this.executeInOrder(tasks, []);
  }

  moveDashboards(dashboardSlugs, toFolder) {
    const tasks = [];

    for (let slug of dashboardSlugs) {
      tasks.push(this.createTask(this.moveDashboard.bind(this), true, slug, toFolder));
    }

    return this.executeInOrder(tasks, []).then(result => {
      return {
        totalCount: result.length,
        successCount: _.filter(result, { succeeded: true }).length,
        alreadyInFolderCount: _.filter(result, { alreadyInFolder: true }).length,
      };
    });
  }

  private moveDashboard(slug, toFolder) {
    let deferred = this.$q.defer();

    this.getDashboard('db', slug).then(fullDash => {
      const model = new DashboardModel(fullDash.dashboard, fullDash.meta);

      if ((!fullDash.meta.folderId && toFolder.id === 0) || fullDash.meta.folderId === toFolder.id) {
        deferred.resolve({ alreadyInFolder: true });
        return;
      }

      const clone = model.getSaveModelClone();
      let options = {
        folderId: toFolder.id,
        overwrite: false,
      };

      this.saveDashboard(clone, options)
        .then(() => {
          deferred.resolve({ succeeded: true });
        })
        .catch(err => {
          if (err.data && err.data.status === 'plugin-dashboard') {
            err.isHandled = true;
            options.overwrite = true;

            this.saveDashboard(clone, options)
              .then(() => {
                deferred.resolve({ succeeded: true });
              })
              .catch(err => {
                deferred.resolve({ succeeded: false });
              });
          } else {
            deferred.resolve({ succeeded: false });
          }
        });
    });

    return deferred.promise;
  }

  private createTask(fn, ignoreRejections, ...args: any[]) {
    return result => {
      return fn
        .apply(null, args)
        .then(res => {
          return Array.prototype.concat(result, [res]);
        })
        .catch(err => {
          if (ignoreRejections) {
            return result;
          }

          throw err;
        });
    };
  }

  private executeInOrder(tasks, initialValue) {
    return tasks.reduce(this.$q.when, initialValue);
  }
}

coreModule.service('backendSrv', BackendSrv);
