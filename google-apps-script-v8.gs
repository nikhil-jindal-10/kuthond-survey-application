const SHEET_NAME = 'Mobile Data';
const USERS_SHEET = 'Users';

function doGet() {
  return json_({success:true, message:'Mobile collection API is running'});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (body.action === 'login') return login_(body);
    if (body.action === 'check_duplicate') return checkDuplicate_(body);
    if (body.action === 'upload') return upload_(body);

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
        user_name:rowName
      });
    }
  }

  return json_({success:false, message:'Invalid User ID or Password.'});
}

function checkDuplicate_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled.'});
  }

  const accountId = String(body.account_id || '').trim();
  if (!accountId) return json_({success:false, message:'Account ID required.'});

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return json_({success:true, duplicate:false});
  }

  const values = sheet.getDataRange().getValues();
  // Account ID is column 3 in V7/V8 format.
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][2] || '').trim() === accountId) {
      return json_({
        success:true,
        duplicate:true,
        record:{
          user_id:String(values[i][0] || ''),
          user_name:String(values[i][1] || ''),
          account_id:String(values[i][2] || ''),
          village:String(values[i][9] || ''),
          meter_condition:String(values[i][10] || ''),
          mobile_number:String(values[i][11] || ''),
          created_at:String(values[i][12] || '')
        }
      });
    }
  }

  return json_({success:true, duplicate:false});
}

function upload_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled. Please login again.'});
  }

  const records = body.records || [];
  if (!records.length) return json_({success:true, uploaded:0, duplicates:0});

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  ensureHeaders_(sheet);

  const values = sheet.getDataRange().getValues();
  const existingAccounts = new Set();
  const existingPhoneIds = new Set();

  for (let i = 1; i < values.length; i++) {
    existingAccounts.add(String(values[i][2] || '').trim());
    existingPhoneIds.add(String(values[i][13] || '').trim());
  }

  const rows = [];
  const duplicates = [];

  for (const r of records) {
    const localId = String(r.id || '').trim();
    const accountId = String(r.account_id || '').trim();

    // Server is authoritative: Account ID can only exist once.
    if (accountId && existingAccounts.has(accountId)) {
      duplicates.push({
        id: localId,
        account_id: accountId,
        reason: 'Account ID already exists on server'
      });
      continue;
    }

    // Also protect against re-upload of same local record.
    if (localId && existingPhoneIds.has(localId)) {
      duplicates.push({
        id: localId,
        account_id: accountId,
        reason: 'Record already uploaded'
      });
      continue;
    }

    rows.push([
      session.user_id,
      session.user_name,
      accountId,
      r.consumer_name || '',
      r.father_name || '',
      r.address || '',
      r.supply_type || '',
      r.load || '',
      r.sdo_code || '',
      r.village || '',
      r.meter_condition || '',
      r.mobile_number || '',
      r.created_at || '',
      localId
    ]);

    existingAccounts.add(accountId);
    existingPhoneIds.add(localId);
  }

  if (rows.length) {
    sheet.getRange(sheet.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return json_({
    success:true,
    uploaded:rows.length,
    duplicates:duplicates.length,
    duplicate_records:duplicates
  });
}

function getUsersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.getRange(1,1,1,5).setValues([[
      'User ID','User Name','Password Hash','Active','Auth Token'
    ]]);
    sheet.getRange(2,1,1,5).setValues([[
      'admin','Administrator',sha256_('admin123'),'YES',
      Utilities.getUuid() + Utilities.getUuid()
    ]]);
  } else {
    const headers = sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0];
    if (String(headers[0]) !== 'User ID') {
      sheet.getRange(1,1,1,5).setValues([[
        'User ID','User Name','Password Hash','Active','Auth Token'
      ]]);
    } else if (sheet.getLastColumn() < 5) {
      sheet.getRange(1,5).setValue('Auth Token');
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

    if (active === 'YES' && authToken && authToken === token) {
      return {user_id:userId, user_name:userName};
    }
  }
  return null;
}

function ensureHeaders_(sheet) {
  const headers = [
    'User ID','User Name','Account ID','Consumer Name','Father/Husband',
    'Address','Supply Type','Load','SDO Code','Village','Meter Condition',
    'Mobile Number','Created At','Phone Record ID'
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    return;
  }

  const existing = sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0];
  if (String(existing[0]) !== 'User ID') {
    sheet.insertColumnsBefore(1, 2);
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  } else if (existing.length < headers.length) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
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
