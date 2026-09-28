// Development state stays in this checkout; packaged releases use OS app data.
const path=require('node:path');
process.env.BLOGAUTO_RUNTIME_ROOT ||= path.resolve(__dirname,'../runtime');
process.env.BLOGAUTO_USER_DATA ||= path.join(process.env.BLOGAUTO_RUNTIME_ROOT,'app-data');
require('../src/main');
