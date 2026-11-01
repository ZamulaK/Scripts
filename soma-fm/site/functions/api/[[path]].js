// Every /api request on the Christmas Lounge site goes to the shared handler (soma-fm/worker/src/site.js)
import { siteApi } from '../../../worker/src/site.js';

export const onRequest = ({ request, env }) => siteApi(request, env);
