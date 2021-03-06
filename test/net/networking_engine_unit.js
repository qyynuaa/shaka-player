/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

describe('NetworkingEngine', /** @suppress {accessControls} */ () => {
  const StatusPromise = shaka.test.StatusPromise;
  const Util = shaka.test.Util;
  const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
  const originalGetLocationProtocol =
      shaka.net.NetworkingEngine.getLocationProtocol_;

  /** @type {string} */
  let fakeProtocol;
  /** @type {!shaka.net.NetworkingEngine} */
  let networkingEngine;
  /** @type {!jasmine.Spy} */
  let resolveScheme;
  /** @type {!jasmine.Spy} */
  let rejectScheme;
  /** @type {!jasmine.Spy} */
  let onProgress;
  /** @type {!shaka.util.Error} */
  let error;

  beforeAll(() => {
    shaka.net.NetworkingEngine.getLocationProtocol_ = function() {
      return fakeProtocol;
    };
  });

  function makeResolveScheme(spyName) {
    return jasmine.createSpy(spyName).and.callFake(() => {
      return shaka.util.AbortableOperation.completed(createResponse());
    });
  }

  beforeEach(() => {
    fakeProtocol = 'http:';
    error = new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.NETWORK,
        shaka.util.Error.Code.HTTP_ERROR);

    onProgress = jasmine.createSpy('onProgressUpdated');
    networkingEngine = new shaka.net.NetworkingEngine(Util.spyFunc(onProgress));
    resolveScheme = makeResolveScheme('resolve scheme');
    rejectScheme = jasmine.createSpy('reject scheme').and.callFake(() =>
      shaka.util.AbortableOperation.failed(error));
    shaka.net.NetworkingEngine.registerScheme(
        'resolve', Util.spyFunc(resolveScheme),
        shaka.net.NetworkingEngine.PluginPriority.FALLBACK);
    shaka.net.NetworkingEngine.registerScheme(
        'reject', Util.spyFunc(rejectScheme),
        shaka.net.NetworkingEngine.PluginPriority.FALLBACK);
  });

  afterEach(() => {
    shaka.net.NetworkingEngine.unregisterScheme('resolve');
    shaka.net.NetworkingEngine.unregisterScheme('reject');
  });

  afterAll(() => {
    shaka.net.NetworkingEngine.getLocationProtocol_ =
        originalGetLocationProtocol;
  });

  describe('retry', () => {
    it('will retry', (done) => {
      const request = createRequest('reject://foo', {
        maxAttempts: 2,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      rejectScheme.and.callFake(() => {
        if (rejectScheme.calls.count() == 1) {
          return shaka.util.AbortableOperation.failed(error);
        } else {
          return shaka.util.AbortableOperation.completed(createResponse());
        }
      });
      networkingEngine.request(requestType, request).promise
          .catch(fail)
          .then(() => {
            expect(rejectScheme.calls.count()).toBe(2);
            done();
          });
    });

    it('will retry twice', (done) => {
      const request = createRequest('reject://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      rejectScheme.and.callFake(() => {
        if (rejectScheme.calls.count() < 3) {
          return shaka.util.AbortableOperation.failed(error);
        } else {
          return shaka.util.AbortableOperation.completed(createResponse());
        }
      });
      networkingEngine.request(requestType, request).promise
          .catch(fail)
          .then(() => {
            expect(rejectScheme.calls.count()).toBe(3);
            done();
          });
    });

    it('will fail overall', (done) => {
      const request = createRequest('reject://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      networkingEngine.request(requestType, request).promise
          .then(fail)
          .catch((error) => {
            // It is expected to fail with the most recent error.
            expect(error).toEqual(jasmine.any(shaka.util.Error));
            expect(rejectScheme.calls.count()).toBe(3);
          }).then(done);
    });

    describe('backoff', () => {
      const baseDelay = 200;
      const originalDefer = shaka.net.Backoff.defer;
      const realRandom = Math.random;

      /** @type {!jasmine.Spy} */
      let deferSpy;

      afterAll(() => {
        Math.random = realRandom;
        shaka.net.Backoff.defer = originalDefer;
      });

      beforeEach(() => {
        Math.random = () => 0.75;

        deferSpy = jasmine.createSpy('defer');
        deferSpy.and.callFake(originalDefer);
        shaka.net.Backoff.defer = Util.spyFunc(deferSpy);
      });

      it('uses baseDelay', async () => {
        const request = createRequest('reject://foo', {
          maxAttempts: 2,
          baseDelay: baseDelay,
          fuzzFactor: 0,
          backoffFactor: 2,
          timeout: 0,
        });

        try {
          await networkingEngine.request(requestType, request).promise;
          fail();
        } catch (e) {
          expect(deferSpy.calls.count()).toBe(1);
          expect(deferSpy).toHaveBeenCalledWith(baseDelay,
              jasmine.any(Function));
        }
      });

      it('uses backoffFactor', async () => {
        const request = createRequest('reject://foo', {
          maxAttempts: 3,
          baseDelay: baseDelay,
          fuzzFactor: 0,
          backoffFactor: 2,
          timeout: 0,
        });

        try {
          await networkingEngine.request(requestType, request).promise;
          fail();
        } catch (e) {
          expect(deferSpy.calls.count()).toBe(2);
          expect(deferSpy).toHaveBeenCalledWith(baseDelay,
              jasmine.any(Function));
          expect(deferSpy).toHaveBeenCalledWith(baseDelay * 2,
              jasmine.any(Function));
        }
      });

      it('uses fuzzFactor', async () => {
        const request = createRequest('reject://foo', {
          maxAttempts: 2,
          baseDelay: baseDelay,
          fuzzFactor: 1,
          backoffFactor: 1,
          timeout: 0,
        });

        try {
          await networkingEngine.request(requestType, request).promise;
          fail();
        } catch (e) {
          // (rand * 2.0) - 1.0 = (0.75 * 2.0) - 1.0 = 0.5
          // 0.5 * fuzzFactor = 0.5 * 1 = 0.5
          // delay * (1 + 0.5) = baseDelay * (1 + 0.5)
          expect(deferSpy.calls.count()).toBe(1);
          expect(deferSpy).toHaveBeenCalledWith(baseDelay * 1.5,
              jasmine.any(Function));
        }
      });
    });  // describe('backoff')

    it('uses multiple URIs', (done) => {
      const request = createRequest('', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      request.uris = ['reject://foo', 'resolve://foo'];
      networkingEngine.request(requestType, request).promise
          .catch(fail)
          .then(() => {
            expect(rejectScheme.calls.count()).toBe(1);
            expect(resolveScheme.calls.count()).toBe(1);
            done();
          });
    });

    it('won\'t retry for CRITICAL error', (done) => {
      const request = createRequest('reject://foo', {
        maxAttempts: 5,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });

      error.severity = shaka.util.Error.Severity.CRITICAL;
      networkingEngine.request(requestType, request).promise
          .then(fail)
          .catch(() => {
            expect(rejectScheme.calls.count()).toBe(1);
            done();
          });
    });
  });  // describe('retry')

  describe('request', () => {
    function testResolve(schemeSpy) {
      return networkingEngine.request(
          requestType, createRequest('resolve://foo')).promise
          .catch(fail)
          .then(() => {
            expect(schemeSpy).toHaveBeenCalled();
          });
    }

    it('uses registered schemes', (done) => {
      testResolve(resolveScheme).then(done);
    });

    it('uses registered scheme plugins in order of priority', (done) => {
      const applicationResolveScheme =
          makeResolveScheme('application resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(applicationResolveScheme),
          shaka.net.NetworkingEngine.PluginPriority.APPLICATION);
      const preferredResolveScheme =
          makeResolveScheme('preferred resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(preferredResolveScheme),
          shaka.net.NetworkingEngine.PluginPriority.PREFERRED);

      testResolve(applicationResolveScheme).then(done);
    });

    it('uses newest scheme plugin in case of tie in priority', (done) => {
      const secondResolveScheme = makeResolveScheme('second resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(secondResolveScheme),
          shaka.net.NetworkingEngine.PluginPriority.FALLBACK);

      testResolve(secondResolveScheme).then(done);
    });

    it('defaults new scheme plugins to application priority', (done) => {
      const secondResolveScheme = makeResolveScheme('second resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(secondResolveScheme));
      const preferredResolveScheme =
          makeResolveScheme('preferred resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(preferredResolveScheme),
          shaka.net.NetworkingEngine.PluginPriority.PREFERRED);

      testResolve(secondResolveScheme).then(done);
    });

    it('can unregister scheme', (done) => {
      shaka.net.NetworkingEngine.unregisterScheme('resolve');
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .then(fail)
          .catch(() => { expect(resolveScheme).not.toHaveBeenCalled(); })
          .then(done);
    });

    it('unregister removes all plugins for scheme at once', (done) => {
      const preferredResolveScheme =
          makeResolveScheme('preferred resolve scheme');
      shaka.net.NetworkingEngine.registerScheme(
          'resolve', Util.spyFunc(preferredResolveScheme),
          shaka.net.NetworkingEngine.PluginPriority.PREFERRED);

      shaka.net.NetworkingEngine.unregisterScheme('resolve');
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .then(fail)
          .catch(() => {
            expect(resolveScheme).not.toHaveBeenCalled();
            expect(preferredResolveScheme).not.toHaveBeenCalled();
          }).then(done);
    });

    it('rejects if scheme does not exist', (done) => {
      networkingEngine.request(requestType, createRequest('foo://foo'))
          .promise
          .then(fail)
          .catch(() => { expect(resolveScheme).not.toHaveBeenCalled(); })
          .then(done);
    });

    it('returns the response object', (done) => {
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then((response) => {
            expect(response).toBeTruthy();
            expect(response.data).toBeTruthy();
            expect(response.data.byteLength).toBe(5);
            expect(response.headers).toBeTruthy();
            done();
          });
    });

    it('passes correct arguments to plugin', (done) => {
      const request = createRequest('resolve://foo');
      request.method = 'POST';

      resolveScheme.and.callFake(
          (uri, requestPassed, requestTypePassed) => {
            expect(uri).toBe(request.uris[0]);
            expect(requestPassed).toEqual(request);
            expect(requestTypePassed).toEqual(requestType);
            return shaka.util.AbortableOperation.completed(createResponse());
          });
      networkingEngine.request(requestType, request)
          .promise.catch(fail).then(done);
    });

    it('infers a scheme for // URIs', (done) => {
      fakeProtocol = 'resolve:';
      networkingEngine.request(requestType, createRequest('//foo')).promise
          .catch(fail)
          .then(() => {
            expect(resolveScheme).toHaveBeenCalled();
            expect(resolveScheme.calls.argsFor(0)[0]).toBe('resolve://foo');
            done();
          });
    });

    it('fills in defaults for partial request objects', (done) => {
      const originalRequest = /** @type {shaka.extern.Request} */ ({
        uris: ['resolve://foo'],
      });

      resolveScheme.and.callFake((uri, request, requestTypePassed) => {
        // NetworkingEngine should have filled in these values:
        expect(request.method).toBeTruthy();
        expect(request.headers).toBeTruthy();
        expect(request.retryParameters).toBeTruthy();

        return shaka.util.AbortableOperation.completed(createResponse());
      });
      networkingEngine.request(requestType, originalRequest).promise
          .catch(fail).then(done);
    });
  });  // describe('request')

  describe('request filter', () => {
    /** @type {!jasmine.Spy} */
    let filter;

    beforeEach(() => {
      filter = jasmine.createSpy('request filter');
      networkingEngine.registerRequestFilter(Util.spyFunc(filter));
    });

    afterEach(() => {
      networkingEngine.unregisterRequestFilter(Util.spyFunc(filter));
    });

    it('can be called', (done) => {
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then(() => {
            expect(filter).toHaveBeenCalled();
            done();
          });
    });

    it('called on failure', (done) => {
      networkingEngine.request(requestType, createRequest('reject://foo'))
          .promise
          .then(fail)
          .catch(() => { expect(filter).toHaveBeenCalled(); })
          .then(done);
    });

    it('is given correct arguments', (done) => {
      const request = createRequest('resolve://foo');
      networkingEngine.request(requestType, request).promise
          .catch(fail)
          .then(() => {
            expect(filter.calls.argsFor(0)[0]).toBe(requestType);
            expect(filter.calls.argsFor(0)[1]).toBe(request);
            expect(filter.calls.argsFor(0)[1].uris[0]).toBe(request.uris[0]);
            done();
          });
    });

    it('waits for asynchronous filters', (done) => {
      const responseFilter = jasmine.createSpy('response filter');
      networkingEngine.registerResponseFilter(Util.spyFunc(responseFilter));

      const p = new shaka.util.PublicPromise();
      const p2 = new shaka.util.PublicPromise();
      filter.and.returnValue(p);
      responseFilter.and.returnValue(p2);
      const request = createRequest('resolve://foo');
      const r = new StatusPromise(
          networkingEngine.request(requestType, request).promise);

      Util.delay(0.1).then(() => {
        expect(filter).toHaveBeenCalled();
        expect(resolveScheme).not.toHaveBeenCalled();
        expect(responseFilter).not.toHaveBeenCalled();
        expect(r.status).toBe('pending');
        p.resolve();

        return Util.delay(0.1);
      }).then(() => {
        expect(resolveScheme).toHaveBeenCalled();
        expect(responseFilter).toHaveBeenCalled();
        expect(r.status).toBe('pending');
        p2.resolve();

        return Util.delay(0.1);
      }).then(() => {
        expect(r.status).toBe('resolved');
        done();
      }).catch(fail);
    });

    it('turns errors into shaka errors', (done) => {
      const fakeError = 'fake error';
      filter.and.callFake(() => {
        throw fakeError;
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .then(fail)
          .catch((e) => {
            expect(e.severity).toBe(shaka.util.Error.Severity.CRITICAL);
            expect(e.code).toBe(shaka.util.Error.Code.REQUEST_FILTER_ERROR);
            expect(e.data).toEqual([fakeError]);
            done();
          });
    });

    it('can modify uris', (done) => {
      filter.and.callFake((type, request) => {
        request.uris = ['resolve://foo'];
      });
      networkingEngine.request(requestType, createRequest('reject://foo'))
          .promise
          .catch(fail)
          .then(() => {
            expect(filter).toHaveBeenCalled();
            done();
          });
    });

    it('applies request filters sequentially', (done) => {
      const secondFilter = jasmine.createSpy('second request filter');
      networkingEngine.registerRequestFilter(Util.spyFunc(secondFilter));

      let order = 0;
      filter.and.callFake(() => {
        expect(order).toBe(0);
        order += 1;
      });
      secondFilter.and.callFake(() => {
        expect(order).toBe(1);
        order += 1;
      });

      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then(done);
    });

    it('can modify requests asynchronously', (done) => {
      const p = new shaka.util.PublicPromise();
      filter.and.callFake((type, request) => {
        return p.then(() => {
          request.uris = ['resolve://foo'];
          request.allowCrossSiteCredentials = true;
        });
      });
      networkingEngine.request(requestType, createRequest('reject://foo'))
          .promise
          .catch(fail)
          .then(() => {
            expect(resolveScheme).toHaveBeenCalled();
            expect(resolveScheme.calls.argsFor(0)[1].allowCrossSiteCredentials)
                .toBe(true);
            done();
          });

      Util.delay(0.1).then(() => {
        expect(filter).toHaveBeenCalled();
        expect(resolveScheme).not.toHaveBeenCalled();

        p.resolve();
      });
    });

    it('can modify allowCrossSiteCredentials', (done) => {
      filter.and.callFake((type, request) => {
        request.allowCrossSiteCredentials = true;
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then(() => {
            expect(filter).toHaveBeenCalled();
            expect(resolveScheme).toHaveBeenCalled();
            expect(resolveScheme.calls.argsFor(0)[1].allowCrossSiteCredentials)
                .toBe(true);
            done();
          });
    });

    it('if rejects will stop requests', (done) => {
      const request = createRequest('resolve://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      filter.and.returnValue(Promise.reject());
      networkingEngine.request(requestType, request).promise
          .then(fail)
          .catch(() => {
            expect(resolveScheme).not.toHaveBeenCalled();
            expect(filter.calls.count()).toBe(1);
          })
          .then(done);
    });

    it('if throws will stop requests', (done) => {
      const request = createRequest('resolve://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      filter.and.throwError(error);
      networkingEngine.request(requestType, request).promise
          .then(fail)
          .catch(() => {
            expect(resolveScheme).not.toHaveBeenCalled();
            expect(filter.calls.count()).toBe(1);
          })
          .then(done);
    });

    it('causes no errors to remove an unused filter', () => {
      const unusedFilter = jasmine.createSpy('unused filter');
      networkingEngine.unregisterRequestFilter(Util.spyFunc(unusedFilter));
    });
  });  // describe('request filter')

  describe('response filter', () => {
    /** @type {!jasmine.Spy} */
    let filter;

    beforeEach(() => {
      filter = jasmine.createSpy('response filter');
      networkingEngine.registerResponseFilter(Util.spyFunc(filter));
      resolveScheme.and.callFake((request) => {
        return shaka.util.AbortableOperation.completed(createResponse());
      });
    });

    afterEach(() => {
      networkingEngine.unregisterResponseFilter(Util.spyFunc(filter));
    });

    it('can be called', (done) => {
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then(() => {
            expect(filter).toHaveBeenCalled();
            done();
          });
    });

    it('not called on failure', (done) => {
      networkingEngine.request(requestType, createRequest('reject://foo'))
          .promise
          .then(fail)
          .catch(() => { expect(filter).not.toHaveBeenCalled(); })
          .then(done);
    });

    it('is given correct arguments', (done) => {
      const request = createRequest('resolve://foo');
      networkingEngine.request(requestType, request)
          .promise
          .catch(fail)
          .then(() => {
            expect(filter.calls.argsFor(0)[0]).toBe(requestType);
            expect(filter.calls.argsFor(0)[1]).toBeTruthy();
            expect(filter.calls.argsFor(0)[1].data).toBeTruthy();
            expect(filter.calls.argsFor(0)[1].headers).toBeTruthy();
            done();
          });
    });

    it('can modify data', (done) => {
      filter.and.callFake((type, response) => {
        response.data = new ArrayBuffer(5);
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then((response) => {
            expect(filter).toHaveBeenCalled();
            expect(response).toBeTruthy();
            expect(response.data.byteLength).toBe(5);
            done();
          });
    });

    it('can modify headers', (done) => {
      filter.and.callFake((type, response) => {
        expect(response.headers).toBeTruthy();
        response.headers['DATE'] = 'CAT';
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then((response) => {
            expect(filter).toHaveBeenCalled();
            expect(response).toBeTruthy();
            expect(response.headers['DATE']).toBe('CAT');
            done();
          });
    });

    it('applies response filters sequentially', (done) => {
      const secondFilter = jasmine.createSpy('second response filter');
      networkingEngine.registerResponseFilter(Util.spyFunc(secondFilter));

      let order = 0;
      filter.and.callFake(() => {
        expect(order).toBe(0);
        order += 1;
      });
      secondFilter.and.callFake(() => {
        expect(order).toBe(1);
        order += 1;
      });

      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .catch(fail)
          .then(done);
    });

    it('turns errors into shaka errors', (done) => {
      const fakeError = 'fake error';
      filter.and.callFake(() => {
        throw fakeError;
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .then(fail)
          .catch((e) => {
            expect(e.code).toBe(shaka.util.Error.Code.RESPONSE_FILTER_ERROR);
            expect(e.data).toEqual([fakeError]);
            done();
          });
    });

    it('can modify responses asynchronously', (done) => {
      const p = new shaka.util.PublicPromise();
      filter.and.callFake((type, response) => {
        return p.then(() => {
          expect(response.headers).toBeTruthy();
          response.headers['DATE'] = 'CAT';
          response.data = new ArrayBuffer(5);
        });
      });

      const request = createRequest('resolve://foo');
      const r = new StatusPromise(networkingEngine.request(requestType, request)
          .promise
          .catch(fail)
          .then((response) => {
            expect(response).toBeTruthy();
            expect(response.headers['DATE']).toBe('CAT');
            expect(response.data.byteLength).toBe(5);
            done();
          }));

      Util.delay(0.1).then(() => {
        expect(filter).toHaveBeenCalled();
        expect(r.status).toBe('pending');

        p.resolve();
      });
    });

    it('if throws will stop requests', (done) => {
      filter.and.callFake(() => {
        throw error;
      });
      networkingEngine.request(requestType, createRequest('resolve://foo'))
          .promise
          .then(fail)
          .catch(() => { expect(filter).toHaveBeenCalled(); })
          .then(done);
    });

    it('causes no errors to remove an unused filter', () => {
      const unusedFilter = jasmine.createSpy('unused filter');
      networkingEngine.unregisterResponseFilter(Util.spyFunc(unusedFilter));
    });
  });  // describe('response filter')

  describe('destroy', () => {
    it('waits for all operations to complete', (done) => {
      const request = createRequest('resolve://foo');
      const p = new shaka.util.PublicPromise();
      resolveScheme.and.returnValue(
          shaka.util.AbortableOperation.notAbortable(p));

      const r1 = new StatusPromise(
          networkingEngine.request(requestType, request).promise);
      const r2 = new StatusPromise(
          networkingEngine.request(requestType, request).promise);

      expect(r1.status).toBe('pending');
      expect(r2.status).toBe('pending');

      /** @type {!shaka.test.StatusPromise} */
      let d;
      Util.delay(0.1).then(() => {
        d = new StatusPromise(networkingEngine.destroy());
        expect(d.status).toBe('pending');
        expect(r1.status).toBe('pending');
        expect(r2.status).toBe('pending');
        return Util.delay(0.1);
      }).then(() => {
        expect(d.status).toBe('pending');
        p.resolve({});
        return d;
      }).then(() => {
        return Util.delay(0.1);
      }).then(() => {
        expect(r1.status).not.toBe('pending');
        expect(r2.status).not.toBe('pending');
        expect(d.status).toBe('resolved');
      }).catch(fail).then(done);
    });

    it('causes requests to reject if called while filtering', (done) => {
      const filter = jasmine.createSpy('request filter');
      networkingEngine.registerRequestFilter(Util.spyFunc(filter));
      const p = new shaka.util.PublicPromise();
      filter.and.returnValue(p);

      const request = createRequest('resolve://foo', {
        maxAttempts: 1,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });
      const r = new StatusPromise(
          networkingEngine.request(requestType, request).promise);

      /** @type {!shaka.test.StatusPromise} */
      let d;
      Util.delay(0.1).then(() => {
        expect(filter).toHaveBeenCalled();
        expect(r.status).toBe('pending');

        d = new StatusPromise(networkingEngine.destroy());
        p.resolve();

        return Util.delay(0.1);
      }).then(() => {
        expect(d.status).toBe('resolved');
        expect(r.status).toBe('rejected');
        expect(resolveScheme).not.toHaveBeenCalled();
      }).catch(fail).then(done);
    });

    it('resolves even when a request fails', (done) => {
      const request = createRequest('reject://foo');
      const p = new shaka.util.PublicPromise();
      rejectScheme.and.returnValue(
          shaka.util.AbortableOperation.notAbortable(p));

      const r1 = new StatusPromise(
          networkingEngine.request(requestType, request).promise);
      const r2 = new StatusPromise(
          networkingEngine.request(requestType, request).promise);

      expect(r1.status).toBe('pending');
      expect(r2.status).toBe('pending');

      /** @type {!shaka.test.StatusPromise} */
      let d;
      Util.delay(0.1).then(() => {
        d = new StatusPromise(networkingEngine.destroy());
        expect(d.status).toBe('pending');

        return Util.delay(0.1);
      }).then(() => {
        expect(d.status).toBe('pending');
        p.reject(error);
        return d;
      }).then(() => {
        return Util.delay(0.1);
      }).then(() => {
        expect(r1.status).toBe('rejected');
        expect(r2.status).toBe('rejected');
        expect(d.status).toBe('resolved');
      }).catch(fail).then(done);
    });

    it('prevents new requests', (done) => {
      const request = createRequest('resolve://foo');

      const d = new StatusPromise(networkingEngine.destroy());
      expect(d.status).toBe('pending');

      const r = new StatusPromise(
          networkingEngine.request(requestType, request).promise);

      Util.delay(0.1).then(() => {
        // A new request has not been made.
        expect(resolveScheme.calls.count()).toBe(0);

        expect(d.status).toBe('resolved');
        expect(r.status).toBe('rejected');
        done();
      });
    });

    it('does not allow further retries', (done) => {
      const request = createRequest('reject://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });

      const p1 = new shaka.util.PublicPromise();
      const p2 = new shaka.util.PublicPromise();
      rejectScheme.and.callFake(() => {
        // Return p1 the first time, then p2 the second time.
        return (rejectScheme.calls.count() == 1) ?
            shaka.util.AbortableOperation.notAbortable(p1) :
            shaka.util.AbortableOperation.notAbortable(p2);
      });

      const r = new StatusPromise(
          networkingEngine.request(requestType, request).promise);
      /** @type {shaka.test.StatusPromise} */
      let d;
      Util.delay(0.1).then(() => {
        expect(rejectScheme.calls.count()).toBe(1);

        d = new StatusPromise(networkingEngine.destroy());
        expect(d.status).toBe('pending');

        return Util.delay(0.1);
      }).then(() => {
        expect(d.status).toBe('pending');
        expect(rejectScheme.calls.count()).toBe(1);
        // Reject the initial request.
        p1.reject(error);
        // Resolve any retry, but since we have already been destroyed, this
        // promise should not be used.
        p2.resolve();
        return d;
      }).then(() => {
        return Util.delay(0.1);
      }).then(() => {
        expect(d.status).toBe('resolved');
        // The request was never retried.
        expect(r.status).toBe('rejected');
        expect(rejectScheme.calls.count()).toBe(1);
      }).catch(fail).then(done);
    });
  });  // describe('destroy')

  it('ignores cache hits', (done) => {
    const onSegmentDownloaded = jasmine.createSpy('onSegmentDownloaded');
    networkingEngine =
        new shaka.net.NetworkingEngine(Util.spyFunc(onSegmentDownloaded));

    networkingEngine.request(requestType, createRequest('resolve://foo'))
        .promise
        .then(() => {
          expect(onSegmentDownloaded).toHaveBeenCalled();
          onSegmentDownloaded.calls.reset();

          resolveScheme.and.callFake(() => {
            return shaka.util.AbortableOperation.completed(createResponse());
          });
          return networkingEngine.request(
              requestType, createRequest('resolve://foo'));
        })
        .then(() => {
          expect(onSegmentDownloaded).not.toHaveBeenCalled();
        })
        .catch(fail)
        .then(done);
  });

  describe('\'retry\' event', () => {
    /** @type {shaka.extern.Request} */
    let request;
    /** @type {jasmine.Spy} */
    let retrySpy;

    beforeEach(() => {
      request = createRequest('reject://foo', {
        maxAttempts: 3,
        baseDelay: 0,
        backoffFactor: 0,
        fuzzFactor: 0,
        timeout: 0,
      });

      retrySpy = jasmine.createSpy('retry listener');
      networkingEngine.addEventListener('retry', Util.spyFunc(retrySpy));
    });

    it('is called on recoverable error', async () => {
      const error1 = new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.HTTP_ERROR);
      const error2 = new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.BAD_HTTP_STATUS);
      const resolve = createResponse();
      rejectScheme.and.callFake(() => {
        switch (rejectScheme.calls.count()) {
          case 1: return shaka.util.AbortableOperation.failed(error1);
          case 2: return shaka.util.AbortableOperation.failed(error2);
          default: return shaka.util.AbortableOperation.completed(resolve);
        }
      });
      await networkingEngine.request(requestType, request).promise;
      expect(retrySpy.calls.count()).toEqual(2);
      if (retrySpy.calls.count() == 2) {
        const event1 = retrySpy.calls.argsFor(0)[0];
        const event2 = retrySpy.calls.argsFor(1)[0];
        expect(event1.error).toBe(error1);
        expect(event2.error).toBe(error2);
      }
    });

    it('is not called on critical errors', async () => {
      error = new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.HTTP_ERROR);
      try {
        await networkingEngine.request(requestType, request).promise;
        fail('not reached');
      } catch (unused) {
        expect(retrySpy).not.toHaveBeenCalled();
      }
    });
  });

  describe('abort', () => {
    /** @type {!shaka.util.Error} */
    let abortError;

    beforeEach(() => {
      abortError = new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.PLAYER,
          shaka.util.Error.Code.OPERATION_ABORTED);
    });

    it('interrupts request filters', (done) => {
      const filter1Promise = new shaka.util.PublicPromise();
      const filter1Spy = jasmine.createSpy('filter 1')
          .and.returnValue(filter1Promise);
      const filter1 = Util.spyFunc(filter1Spy);
      networkingEngine.registerRequestFilter(filter1);

      const filter2Promise = new shaka.util.PublicPromise();
      const filter2Spy = jasmine.createSpy('filter 2')
          .and.returnValue(filter2Promise);
      const filter2 = Util.spyFunc(filter2Spy);
      networkingEngine.registerRequestFilter(filter2);

      const request = createRequest('resolve://foo');
      const operation = networkingEngine.request(requestType, request);
      const r = new StatusPromise(operation.promise);

      Util.delay(0.1).then(() => {
        // The first filter has been called, but not the second, and not the
        // scheme plugin.
        expect(filter1Spy).toHaveBeenCalled();
        expect(filter2Spy).not.toHaveBeenCalled();
        expect(resolveScheme).not.toHaveBeenCalled();

        // The operation is still pending.
        expect(r.status).toBe('pending');

        operation.abort();

        filter1Promise.resolve();
        return Util.delay(0.1);
      }).then(() => {
        // The second filter has not been called, nor has the scheme plugin.
        // The filter chain was interrupted by abort().
        expect(filter2Spy).not.toHaveBeenCalled();
        expect(resolveScheme).not.toHaveBeenCalled();

        // The operation has been aborted.
        expect(r.status).toBe('rejected');
        return operation.promise.catch((e) => {
          Util.expectToEqualError(e, abortError);
        });
      }).catch(fail).then(done);
    });

    it('interrupts scheme plugins', (done) => {
      const p = new shaka.util.PublicPromise();
      const abortSpy = jasmine.createSpy('abort');
      const abort = Util.spyFunc(abortSpy);

      resolveScheme.and.returnValue(
          new shaka.util.AbortableOperation(p, abort));
      expect(resolveScheme).not.toHaveBeenCalled();

      const request = createRequest('resolve://foo');
      const operation = networkingEngine.request(requestType, request);
      const r = new StatusPromise(operation.promise);

      Util.delay(0.1).then(() => {
        // A request has been made, but not completed yet.
        expect(resolveScheme).toHaveBeenCalled();
        expect(r.status).toBe('pending');

        expect(abortSpy).not.toHaveBeenCalled();
        return operation.abort();
      }).then(() => {
        expect(abortSpy).toHaveBeenCalled();
        p.resolve();

        // The operation has been aborted.
        expect(r.status).toBe('rejected');
        return operation.promise.catch((e) => {
          Util.expectToEqualError(e, abortError);
        });
      }).catch(fail).then(done);
    });

    it('interrupts response filters', (done) => {
      const filter1Promise = new shaka.util.PublicPromise();
      const filter1Spy = jasmine.createSpy('filter 1')
          .and.returnValue(filter1Promise);
      const filter1 = Util.spyFunc(filter1Spy);
      networkingEngine.registerResponseFilter(filter1);

      const filter2Promise = new shaka.util.PublicPromise();
      const filter2Spy = jasmine.createSpy('filter 2')
          .and.returnValue(filter2Promise);
      const filter2 = Util.spyFunc(filter2Spy);
      networkingEngine.registerResponseFilter(filter2);

      const request = createRequest('resolve://foo');
      const operation = networkingEngine.request(requestType, request);
      const r = new StatusPromise(operation.promise);

      Util.delay(0.1).then(() => {
        // The scheme plugin has been called, and the first filter has been
        // called, but not the second.
        expect(resolveScheme).toHaveBeenCalled();
        expect(filter1Spy).toHaveBeenCalled();
        expect(filter2Spy).not.toHaveBeenCalled();

        // The operation is still pending.
        expect(r.status).toBe('pending');

        operation.abort();

        filter1Promise.resolve();
        return Util.delay(0.1);
      }).then(() => {
        // The second filter has still not been called.
        // The filter chain was interrupted by abort().
        expect(filter2Spy).not.toHaveBeenCalled();

        // The operation has been aborted.
        expect(r.status).toBe('rejected');
        return operation.promise.catch((e) => {
          Util.expectToEqualError(e, abortError);
        });
      }).catch(fail).then(done);
    });

    it('is called by destroy', (done) => {
      const p = new shaka.util.PublicPromise();
      const abortSpy = jasmine.createSpy('abort');
      const abort = Util.spyFunc(abortSpy);

      resolveScheme.and.returnValue(
          new shaka.util.AbortableOperation(p, abort));
      expect(resolveScheme).not.toHaveBeenCalled();

      const request = createRequest('resolve://foo');
      const operation = networkingEngine.request(requestType, request);
      const r = new StatusPromise(operation.promise);

      Util.delay(0.1).then(() => {
        // A request has been made, but not completed yet.
        expect(resolveScheme).toHaveBeenCalled();
        expect(abortSpy).not.toHaveBeenCalled();
        return networkingEngine.destroy();
      }).then(() => {
        expect(abortSpy).toHaveBeenCalled();
        p.resolve();

        // The operation has been aborted.
        expect(r.status).toBe('rejected');
        return operation.promise.catch((e) => {
          Util.expectToEqualError(e, abortError);
        });
      }).catch(fail).then(done);
    });
  });

  describe('progress events', () => {
    it('forwards progress events to caller', async () => {
      /** @const {!shaka.util.PublicPromise} */
      const delay = new shaka.util.PublicPromise();
      resolveScheme.and.callFake((uri, req, type, progress) => {
        progress(1, 2, 3);

        const p = (async () => {
          progress(4, 5, 6);
          await delay;
          progress(7, 8, 9);
          return createResponse();
        })();
        return new shaka.util.AbortableOperation(p, () => {});
      });

      /** @const {shaka.net.NetworkingEngine.PendingRequest} */
      const resp = networkingEngine.request(
          requestType, createRequest('resolve://'));
      await Util.delay(0.01);  // Allow Promises to resolve.
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(1, 2);
      expect(onProgress).toHaveBeenCalledWith(4, 5);
      onProgress.calls.reset();

      delay.resolve();
      await resp.promise;
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(7, 8);
    });

    it('doesn\'t forward progress events for non-SEGMENT', async () => {
      resolveScheme.and.callFake((uri, req, type, progress) => {
        progress(1, 2, 3);
        progress(4, 5, 6);
        return shaka.util.AbortableOperation.completed(createResponse());
      });

      const resp = networkingEngine.request(
          shaka.net.NetworkingEngine.RequestType.LICENSE,
          createRequest('resolve://'));
      await resp.promise;
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('repports progress even if plugin doesn\'t report it', async () => {
      const resp = networkingEngine.request(
          requestType, createRequest('resolve://'));
      await resp.promise;
      expect(onProgress).toHaveBeenCalled();
    });
  });

  /**
   * @param {string} uri
   * @param {shaka.extern.RetryParameters=} retryParameters
   * @return {shaka.extern.Request}
   */
  function createRequest(uri, retryParameters) {
    retryParameters = retryParameters ||
        shaka.net.NetworkingEngine.defaultRetryParameters();
    return shaka.net.NetworkingEngine.makeRequest([uri], retryParameters);
  }

  describe('createSegmentRequest', () => {
    it('does not add range headers to requests for the whole segment', () => {
      // You had _one_ job, createSegmentRequest!

      const request = shaka.util.Networking.createSegmentRequest(
          /* uris= */ ['/foo.mp4'],
          /* start= */ 0,
          /* end= */ null,
          shaka.net.NetworkingEngine.defaultRetryParameters());

      const keys = Object.keys(request.headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain('range');
    });
  });

  /** @return {shaka.extern.Response} */
  function createResponse() {
    return {uri: '', data: new ArrayBuffer(5), headers: {}};
  }
});  // describe('NetworkingEngine')
