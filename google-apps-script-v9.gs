const SHEET_NAME = 'Mobile Data';
const USERS_SHEET = 'Users';

function doGet() {
  return json_({success:true, message:'Mobile collection API is running'});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (body.action === 'login') return login_(body);
    if (body.action === 'check_auth') return checkAuth_(body);
    if (body.action === 'check_upload_status') return checkUploadStatus_(body);
    if (body.action === 'upload') return upload_(body);
    if (body.action === 'sync_upload_status') return syncUploadStatus_(body);

    if (body.action === 'list_users') return listUsers_(body);
    if (body.action === 'create_user') return createUser_(body);
    if (body.action === 'set_user_active') return setUserActive_(body);
    if (body.action === 'dashboard') return dashboard_(body);
    if (body.action === 'dashboard_filters') return dashboard_filters_(body);
    if (body.action === 'export_report') return exportReport_(body);
    if (body.action === 'get_record') return getRecord_(body);
    if (body.action === 'update_record') return updateRecord_(body);

    return json_({success:false, message:'Invalid action'});
  } catch (err) {
    return json_({success:false, message:String(err)});
  }
}

function login_(body) {
  const userId = String(body.user_id || '').trim();
  const password = String(body.password || '');

  if (!userId || !password) {
    return json_({success:false, message:'User ID and password are required.'});
  }

  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rowUser = String(data[i][0] || '').trim();
    const rowName = String(data[i][1] || '').trim();
    const rowHash = String(data[i][2] || '').trim();
    const active = String(data[i][3] || '').trim().toUpperCase();
    let authToken = String(data[i][4] || '').trim();
    const isAdmin = String(data[i][5] || '').trim().toUpperCase() === 'YES';

    if (rowUser.toLowerCase() === userId.toLowerCase() &&
        active === 'YES' &&
        rowHash === sha256_(password)) {

      if (!authToken) {
        authToken = Utilities.getUuid() + Utilities.getUuid();
        sheet.getRange(i + 1, 5).setValue(authToken);
      }

      return json_({
        success:true,
        token:authToken,
        user_id:rowUser,
        user_name:rowName,
        is_admin:isAdmin
      });
    }
  }

  return json_({success:false, message:'Invalid User ID or Password.'});
}


function checkAuth_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled.'});
  }
  return json_({
    success:true,
    user_id:session.user_id,
    user_name:session.user_name,
    is_admin:session.is_admin
  });
}



function checkUploadStatus_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) return json_({success:false, message:'Login invalid or user disabled.'});

  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return json_({success:true,uploaded_keys:[]});

  const values=sheet.getDataRange().getValues();
  const uploadedKeys=new Set();

  for(let i=1;i<values.length;i++){
    const user=String(values[i][0]||'').trim().toLowerCase();
    const account=String(values[i][2]||'').trim();
    const surveyType=String(values[i][15]||'EXISTING CONSUMER').trim().toUpperCase();
    const surveyId=String(values[i][18]||'').trim();

    if(surveyType === 'CONNECTION NOT IN DATABASE'){
      if(user && surveyId) uploadedKeys.add(user+'|SURVEY|'+surveyId);
    }else if(user && account){
      uploadedKeys.add(user+'|ACCOUNT|'+account);
    }
  }

  const found=[];
  for(const r of (body.records||[])){
    const user=session.user_id.trim().toLowerCase();
    const key=(String(r.survey_type||'').toUpperCase()==='CONNECTION NOT IN DATABASE')
      ? user+'|SURVEY|'+String(r.survey_id||'').trim()
      : user+'|ACCOUNT|'+String(r.account_id||'').trim();
    if(uploadedKeys.has(key)) found.push(key);
  }
  return json_({success:true,uploaded_keys:found});
}

function upload_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled. Please login again.'});
  }

  const records=body.records||[];
  if(!records.length) return json_({success:true,uploaded:0,duplicates:0});

  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sheet=ss.getSheetByName(SHEET_NAME);
  if(!sheet) sheet=ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet);

  const lock=LockService.getScriptLock();
  lock.waitLock(30000);

  try{
    const values=sheet.getDataRange().getValues();
    const existingKeys=new Set();

    // IMPORTANT: this key is only for preventing the exact same user's
    // already-uploaded survey from being uploaded again. Account IDs from
    // different users are still allowed.
    for(let i=1;i<values.length;i++){
      const user=String(values[i][0]||'').trim().toLowerCase();
      const account=String(values[i][2]||'').trim();
      const type=String(values[i][15]||'EXISTING CONSUMER').trim().toUpperCase();
      const surveyId=String(values[i][18]||'').trim();
      if(type==='CONNECTION NOT IN DATABASE'){
        if(user && surveyId) existingKeys.add(user+'|SURVEY|'+surveyId);
      }else if(user && account){
        existingKeys.add(user+'|ACCOUNT|'+account);
      }
    }

    const rows=[];
    let duplicates=0;

    for(const r of records){
      const type=String(r.survey_type||'EXISTING CONSUMER').trim().toUpperCase();
      const user=String(session.user_id||'').trim().toLowerCase();
      const account=String(r.account_id||'').trim();
      const surveyId=String(r.survey_id||'').trim();

      const key=type==='CONNECTION NOT IN DATABASE'
        ? user+'|SURVEY|'+surveyId
        : user+'|ACCOUNT|'+account;

      if(key && existingKeys.has(key)){
        duplicates++;
        continue;
      }

      rows.push([
        session.user_id,
        session.user_name,
        account,
        r.consumer_name||'',
        r.father_name||'',
        r.address||'',
        r.supply_type||'',
        r.load||'',
        r.sdo_code||'',
        r.village||'',
        r.meter_condition||'',
        r.ac_installed||'',
        r.mobile_number||'',
        r.created_at||'',
        '', // Local Record ID no longer used as server identity
        r.survey_type||'EXISTING CONSUMER',
        r.survey_status||'CONSUMER FOUND',
        r.connection_type||'',
        surveyId,
        r.house_locked||'NO',
        r.mobile_refused||'NO',
        r.meter_installed||'',
        r.meter_number||'',
        r.current_reading||'',
        r.outstanding||'',
        r.connected_load||'',
        r.remarks||''
      ]);

      if(key) existingKeys.add(key);
    }

    if(rows.length){
      sheet.getRange(sheet.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
    }

    return json_({success:true,uploaded:rows.length,duplicates:duplicates});
  }finally{
    lock.releaseLock();
  }
}


function syncUploadStatus_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled.'});
  }

  const requested = Array.isArray(body.records) ? body.records : [];
  if (!requested.length) return json_({success:true, present_keys:[]});

  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName(SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return json_({success:true, present_keys:[]});
  }

  ensureHeaders_(sheet);

  const values=sheet.getDataRange().getValues();
  const presentKeys=new Set();

  // Sheet columns:
  // 0 User ID, 2 Account ID, 15 Survey Type, 18 Survey ID.
  for(let i=1;i<values.length;i++){
    const user=String(values[i][0]||'').trim().toLowerCase();
    const account=String(values[i][2]||'').trim();
    const type=String(values[i][15]||'EXISTING CONSUMER').trim().toUpperCase();
    const surveyId=String(values[i][18]||'').trim();

    if(type === 'CONNECTION NOT IN DATABASE'){
      if(user && surveyId){
        presentKeys.add(user+'|SURVEY|'+surveyId);
      }
    }else if(user && account){
      presentKeys.add(user+'|ACCOUNT|'+account);
    }
  }

  const found=[];
  for(const r of requested){
    const user=String(r.user_id || '').trim().toLowerCase();
    const account=String(r.account_id || '').trim();
    const type=String(r.survey_type || 'EXISTING CONSUMER').trim().toUpperCase();
    const surveyId=String(r.survey_id || '').trim();

    const key=(type === 'CONNECTION NOT IN DATABASE')
      ? user+'|SURVEY|'+surveyId
      : user+'|ACCOUNT|'+account;

    if(user && ((type === 'CONNECTION NOT IN DATABASE' && surveyId) ||
                (type !== 'CONNECTION NOT IN DATABASE' && account)) &&
       presentKeys.has(key)){
      found.push(key);
    }
  }

  return json_({success:true, present_keys:found});
}

function listUsers_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();
  const users = [];

  for (let i = 1; i < data.length; i++) {
    users.push({
      user_id:String(data[i][0] || ''),
      user_name:String(data[i][1] || ''),
      active:String(data[i][3] || '')
    });
  }

  return json_({success:true, users});
}

function createUser_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const userId = String(body.user_id || '').trim();
  const userName = String(body.user_name || '').trim();
  const password = String(body.password || '');

  if (!userId || !userName || !password) {
    return json_({success:false, message:'User ID, User Name and Password are required.'});
  }

  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === userId.toLowerCase()) {
      return json_({success:false, message:'User ID already exists.'});
    }
  }

  sheet.appendRow([
    userId,
    userName,
    sha256_(password),
    'YES',
    Utilities.getUuid() + Utilities.getUuid(),
    'NO'
  ]);

  return json_({success:true});
}

function setUserActive_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const userId = String(body.user_id || '').trim();
  const active = String(body.active || '').toUpperCase() === 'YES' ? 'YES' : 'NO';

  if (userId.toLowerCase() === admin.user_id.toLowerCase() && active === 'NO') {
    return json_({success:false, message:'You cannot disable your own admin account.'});
  }

  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === userId.toLowerCase()) {
      sheet.getRange(i + 1, 4).setValue(active);
      return json_({success:true});
    }
  }

  return json_({success:false, message:'User not found.'});
}

function requireAdmin_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session || !session.is_admin) return null;
  return session;
}


function dashboard_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return json_({
      success:true,total:0,user_count:0,village_count:0,
      user_wise:[],village_wise:[],meter_condition:[],ac_installed:[]
    });
  }

  const fromDate = String(body.from_date || '').trim();
  const toDate = String(body.to_date || '').trim();
  const filterUser = String(body.user_id || '').trim();
  const filterVillage = String(body.village || '').trim();

  const values=sheet.getDataRange().getValues();
  const users={}, villages={}, meters={}, acs={};
  let total=0;

  for(let i=1;i<values.length;i++){
    const rowUserId=String(values[i][0]||'').trim();
    const rowUserName=String(values[i][1]||'').trim();
    const rowVillage=String(values[i][9]||'').trim();
    const rowMeter=String(values[i][10]||'').trim();
    const rowAc=String(values[i][11]||'').trim();
    const rawCreated=values[i][13];

    if (filterUser && rowUserId !== filterUser) continue;
    if (filterVillage && rowVillage !== filterVillage) continue;

    if (fromDate || toDate) {
      const d = rawCreated instanceof Date ? rawCreated : new Date(String(rawCreated||''));
      if (isNaN(d.getTime())) continue;
      const day = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (fromDate && day < fromDate) continue;
      if (toDate && day > toDate) continue;
    }

    const user = rowUserName || rowUserId || 'Unknown';
    const village = rowVillage || 'Unknown';
    const meter = rowMeter || 'Unknown';
    const ac = rowAc || 'Unknown';

    users[user]=(users[user]||0)+1;
    villages[village]=(villages[village]||0)+1;
    meters[meter]=(meters[meter]||0)+1;
    acs[ac]=(acs[ac]||0)+1;
    total++;
  }

  const toList_=obj=>Object.keys(obj)
    .map(k=>({name:k,count:obj[k]}))
    .sort((a,b)=>b.count-a.count);

  return json_({
    success:true,
    total:total,
    user_count:Object.keys(users).length,
    village_count:Object.keys(villages).length,
    user_wise:toList_(users),
    village_wise:toList_(villages),
    meter_condition:toList_(meters),
    ac_installed:toList_(acs)
  });
}

function dashboard_filters_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const userMap = {};
  const villages = {};

  if (sheet && sheet.getLastRow() >= 2) {
    const values=sheet.getDataRange().getValues();
    for(let i=1;i<values.length;i++){
      const userId=String(values[i][0]||'').trim();
      const userName=String(values[i][1]||'').trim();
      const village=String(values[i][9]||'').trim();
      if(userId) userMap[userId]=userName || userId;
      if(village) villages[village]=true;
    }
  }

  const users=Object.keys(userMap)
    .map(id=>({user_id:id,user_name:userMap[id]}))
    .sort((a,b)=>a.user_name.localeCompare(b.user_name));

  return json_({
    success:true,
    users:users,
    villages:Object.keys(villages).sort((a,b)=>a.localeCompare(b))
  });
}


function exportReport_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return json_({success:true, rows:[]});
  }

  const fromDate = String(body.from_date || '').trim();
  const toDate = String(body.to_date || '').trim();
  const filterUser = String(body.user_id || '').trim();
  const filterVillage = String(body.village || '').trim();

  const values = sheet.getDataRange().getValues();
  const rows = [];

  for (let i=1; i<values.length; i++) {
    const rowUserId=String(values[i][0]||'').trim();
    const rowUserName=String(values[i][1]||'').trim();
    const rowVillage=String(values[i][9]||'').trim();
    const rawCreated=values[i][13];

    if (filterUser && rowUserId !== filterUser) continue;
    if (filterVillage && rowVillage !== filterVillage) continue;

    if (fromDate || toDate) {
      const d = rawCreated instanceof Date ? rawCreated : new Date(String(rawCreated||''));
      if (isNaN(d.getTime())) continue;
      const day = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (fromDate && day < fromDate) continue;
      if (toDate && day > toDate) continue;
    }

    rows.push({
      user_id:rowUserId,
      user_name:rowUserName,
      account_id:String(values[i][2]||''),
      consumer_name:String(values[i][3]||''),
      father_name:String(values[i][4]||''),
      address:String(values[i][5]||''),
      supply_type:String(values[i][6]||''),
      load:String(values[i][7]||''),
      sdo_code:String(values[i][8]||''),
      village:rowVillage,
      meter_condition:String(values[i][10]||''),
      ac_installed:String(values[i][11]||''),
      mobile_number:String(values[i][12]||''),
      created_at: rawCreated instanceof Date
        ? Utilities.formatDate(rawCreated, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss')
        : String(rawCreated||''),
      survey_type:String(values[i][15]||''),
      survey_status:String(values[i][16]||''),
      connection_type:String(values[i][17]||''),
      survey_id:String(values[i][18]||''),
      house_locked:String(values[i][19]||''),
      mobile_refused:String(values[i][20]||''),
      meter_installed:String(values[i][21]||''),
      meter_number:String(values[i][22]||''),
      current_reading:String(values[i][23]||''),
      outstanding:String(values[i][24]||''),
      connected_load:String(values[i][25]||''),
      remarks:String(values[i][26]||'')
    });
  }

  return json_({success:true, rows:rows});
}


function getRecord_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const accountId=String(body.account_id||'').trim();
  if (!accountId) return json_({success:false,message:'Account ID required.'});

  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow()<2) {
    return json_({success:true,found:false});
  }

  const values=sheet.getDataRange().getValues();

  for(let i=1;i<values.length;i++){
    if(String(values[i][2]||'').trim()===accountId){
      return json_({
        success:true,
        found:true,
        record:rowToRecord_(values[i])
      });
    }
  }

  return json_({success:true,found:false});
}

function updateRecord_(body) {
  const admin = requireAdmin_(body);
  if (!admin) return json_({success:false, code:'AUTH', message:'Admin access required.'});

  const accountId=String(body.account_id||'').trim();
  const village=String(body.village||'').trim();
  const meter=String(body.meter_condition||'').trim().toUpperCase();
  const ac=String(body.ac_installed||'').trim().toUpperCase();
  const mobile=String(body.mobile_number||'').replace(/\D/g,'');

  if (!accountId) return json_({success:false,message:'Account ID required.'});
  if (!village) return json_({success:false,message:'Village is required.'});
  if (!['OK','DAMAGED','NOT INSTALLED'].includes(meter)) {
    return json_({success:false,message:'Invalid meter condition.'});
  }
  if (!['YES','NO'].includes(ac)) {
    return json_({success:false,message:'Invalid AC Installed value.'});
  }
  if (!/^\d{10}$/.test(mobile)) {
    return json_({success:false,message:'Invalid mobile number.'});
  }

  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow()<2) {
    return json_({success:false,message:'Record not found.'});
  }

  const values=sheet.getDataRange().getValues();

  for(let i=1;i<values.length;i++){
    if(String(values[i][2]||'').trim()===accountId){
      // V12/V13 columns:
      // J Village, K Meter Condition, L AC Installed, M Mobile Number
      sheet.getRange(i+1,10).setValue(village);
      sheet.getRange(i+1,11).setValue(meter);
      sheet.getRange(i+1,12).setValue(ac);
      sheet.getRange(i+1,13).setValue(mobile);

      // Audit columns are added at the end without changing existing data.
      const auditCols=ensureCorrectionAuditColumns_(sheet);
      const now=new Date();
      sheet.getRange(i+1,auditCols.updatedBy).setValue(admin.user_id);
      sheet.getRange(i+1,auditCols.updatedName).setValue(admin.user_name);
      sheet.getRange(i+1,auditCols.updatedAt).setValue(now);

      const updatedValues=sheet.getRange(i+1,1,1,sheet.getLastColumn()).getValues()[0];

      return json_({
        success:true,
        updated_by:admin.user_name || admin.user_id,
        updated_at:Utilities.formatDate(now,Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm:ss'),
        record:rowToRecord_(updatedValues)
      });
    }
  }

  return json_({success:false,message:'Record not found.'});
}

function ensureCorrectionAuditColumns_(sheet) {
  const required=[
    'Last Corrected By User ID',
    'Last Corrected By Name',
    'Last Corrected At'
  ];

  const lastCol=sheet.getLastColumn();
  let headers=sheet.getRange(1,1,1,lastCol).getValues()[0];

  const positions={};
  for(const h of required){
    let idx=headers.indexOf(h);
    if(idx===-1){
      sheet.getRange(1,sheet.getLastColumn()+1).setValue(h);
      headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      idx=headers.indexOf(h);
    }
    positions[h]=idx+1;
  }

  return {
    updatedBy:positions[required[0]],
    updatedName:positions[required[1]],
    updatedAt:positions[required[2]]
  };
}

function rowToRecord_(row) {
  return {
    user_id:String(row[0]||''),
    user_name:String(row[1]||''),
    account_id:String(row[2]||''),
    consumer_name:String(row[3]||''),
    father_name:String(row[4]||''),
    address:String(row[5]||''),
    supply_type:String(row[6]||''),
    load:String(row[7]||''),
    sdo_code:String(row[8]||''),
    village:String(row[9]||''),
    meter_condition:String(row[10]||''),
    ac_installed:String(row[11]||''),
    mobile_number:String(row[12]||''),
    created_at:row[13] instanceof Date
      ? Utilities.formatDate(row[13],Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm:ss')
      : String(row[13]||''),
    local_record_id:String(row[14]||''),
    survey_type:String(row[15]||''),
    survey_status:String(row[16]||''),
    connection_type:String(row[17]||''),
    survey_id:String(row[18]||''),
    house_locked:String(row[19]||''),
    mobile_refused:String(row[20]||''),
    meter_installed:String(row[21]||''),
    meter_number:String(row[22]||''),
    current_reading:String(row[23]||''),
    outstanding:String(row[24]||''),
    connected_load:String(row[25]||''),
    remarks:String(row[26]||'')
  };
}

function getUsersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.getRange(1,1,1,6).setValues([[
      'User ID','User Name','Password Hash','Active','Auth Token','Admin'
    ]]);
    sheet.getRange(2,1,1,6).setValues([[
      'admin','Administrator',sha256_('admin123'),'YES',
      Utilities.getUuid() + Utilities.getUuid(),'YES'
    ]]);
    return sheet;
  }

  // Upgrade older Users sheets created by V6/V7/V8/V9.
  if (sheet.getLastColumn() < 5) {
    sheet.getRange(1,5).setValue('Auth Token');
  }
  if (sheet.getLastColumn() < 6) {
    sheet.getRange(1,6).setValue('Admin');
  }

  // If the Admin column exists but the original "admin" account was created
  // before the Admin feature, automatically promote that setup account.
  const data = sheet.getDataRange().getValues();
  for (let i=1; i<data.length; i++) {
    const userId=String(data[i][0]||'').trim().toLowerCase();
    const active=String(data[i][3]||'').trim().toUpperCase();
    if (userId === 'admin' && active === 'YES') {
      if (String(data[i][5]||'').trim().toUpperCase() !== 'YES') {
        sheet.getRange(i+1,6).setValue('YES');
      }
    }
  }

  return sheet;
}

function getUserByToken_(token) {
  if (!token) return null;

  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const userId = String(data[i][0] || '').trim();
    const userName = String(data[i][1] || '').trim();
    const active = String(data[i][3] || '').trim().toUpperCase();
    const authToken = String(data[i][4] || '').trim();
    const isAdmin = String(data[i][5] || '').trim().toUpperCase() === 'YES';

    if (active === 'YES' && authToken && authToken === token) {
      return {user_id:userId, user_name:userName, is_admin:isAdmin};
    }
  }
  return null;
}

function ensureHeaders_(sheet) {
  const headers = [
    'User ID','User Name','Account ID','Consumer Name','Father/Husband',
    'Address','Supply Type','Load','SDO Code','Village','Meter Condition',
    'AC Installed','Mobile Number','Created At','Local Record ID',
    'Survey Type','Survey Status','Connection Type','Survey ID',
    'House Locked','Mobile Refused','Meter Installed','Meter Number',
    'Current Reading','Outstanding','Connected Load','Remarks'
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    return;
  }

  const lastCol=sheet.getLastColumn();
  let current=sheet.getRange(1,1,1,lastCol).getValues()[0];

  for (let i=0; i<headers.length; i++) {
    if (current.indexOf(headers[i]) === -1) {
      sheet.getRange(1,sheet.getLastColumn()+1).setValue(headers[i]);
      current=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
    }
  }
}

function sha256_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
