const axios = require('axios');
const assert = require('assert');
const Database = require('./database.js');
const Errors = require('./wykop-errors.js');

module.exports = class Core {
	debug = false;
	errors = new Errors();
	database = new Database();

	constructor({ appkey, secret, token, rtoken, environment, debug } = {}) {
		this.debug = debug
		this.database.environment = environment ?? 'https://wykop.pl/api/v3'

		this.instance = axios.create({ baseURL: this.database.environment });
		this.instance.interceptors.response.use(res => {
			return this.#axiosResponseHandler(res)
		}, (err => {
			return this.#axiosErrorHandler(err)
		}));

		this.database.appkey = appkey
		this.database.secret = secret
    	this.saveTokens(token, rtoken)
	}

	#axiosResponseHandler = function(response) {
		if (this.debug) { console.log(this.errors.request.info(response)); }
	    return response.data;
	}

	#axiosErrorHandler = async function(error) {
		if (this.debug) { console.log(this.errors.request.error(error)); }

	    const originalRequest = error.config;
	    if (originalRequest._retry) {
	    	return Promise.reject(error.response.data);
	    }

	    const statusCode = error.response?.status;
	    const captcha = error.response?.data?.error?.captcha;

	    if (this.debug) { console.log("[WykopJS] originalRequest:", originalRequest); }


	    //--- don't retry if we can't connect to the API with our key/secret
	    if (statusCode === 401 && originalRequest.url === '/auth') {
	    	return Promise.reject(error.response.data);
	    }

		//--- remove our rtoken if it's is not valid anymore 
	    if (statusCode === 401 && originalRequest.url === '/refresh-token') {
	    	await this.clearRefreshToken()
	    	return Promise.reject(error.response.data);
	    }

	    //--- since localhost was removed as a recaptcha domain you need to manually login to wykop.pl :) 
		if (statusCode === 401 && captcha) { 
		    if (this.debug) { console.log('[WykopJS] 401: Invalid Credentials; You will need to solve a captcha from this IP on wykop.pl or wait some time before trying logging in again!'); }
	    	return Promise.reject(error.response.data);
	    }
	    
	    //--- encountered an error, trying to get a new token/rtoken and then trying the request again
		if ((statusCode === 403) || (statusCode === 401)) {
			originalRequest._retry = true;
			originalRequest.headers['Authorization'] = 'Bearer ' + await this.getTokens();
			return this.instance.request(originalRequest);
		}

		return Promise.reject(error.response.data);
	}

	#auth = function() {
		this.clearTokens()
		return this.instance.post('/auth', { 
			data: {
				key: this.database.appkey,
				secret: this.database.secret
			},
		}).then(res => {
			return this.saveTokens(res.data.token);
		}).catch(err => {
			return Promise.reject(err)
		});
	}

	getTokens = async function() {
		if (this.database.rtoken) {
			return (await this.#refreshToken()).token;
		} else {
			return (await this.#auth()).token
		}
	}

 	#refreshToken = function() {
		return this.instance.post('/refresh-token', {
			data: {
				refresh_token: this.database.rtoken
			}
		}).then(res => {
			return this.saveTokens(res.data.token, res.data.refresh_token);
		}).catch(err => {
			return Promise.reject(err)
		});
	}

	saveTokens = function(token, rtoken) {
		if (this.debug) { console.log(`[WykopJS] Saving tokens:\n---Token: ${token}\n---Token data (decoded): ${token ? atob(token.split('.')[1]) : token}\n---rtoken: ${rtoken}`); }
		return new Promise(async (resolve, reject) => {
			this.database.token = token ?? null;
			this.database.rtoken = rtoken ?? null;
			this.instance.defaults.headers.common['Authorization'] = 'Bearer '+ token;
			resolve({ token: this.database.token, rtoken: this.database.rtoken });
		});
	}
	
	clearTokens = async function() {
		this.database.clearTokens();
		delete this.instance.defaults.headers.common['Authorization']
	}

	clearRefreshToken = async function() {
		this.database.clearRefreshToken();
	}
}