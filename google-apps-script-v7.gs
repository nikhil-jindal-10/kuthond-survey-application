const SHEET_NAME = 'Mobile Data';
const USERS_SHEET = 'Users';

function doGet() {
  return json_({success:true, message:'Mobile collection API is running'});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (body.action === 'login') return login_(body);
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

      // Create a permanent token only if the user doesn't already have one.
      // The token remains valid until the admin changes/revokes it or the user
      // is disabled. Closing the app does not log the user out.
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

function upload_(body) {
  const session = getUserByToken_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login invalid or user disabled. Please login again.'});
  }

  const records = body.records || [];
  if (!records.length) return json_({success:true, uploaded:0});

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  ensureHeaders_(sheet);

  const lastRow = sheet.getLastRow();
  const phoneIdCol = sheet.getLastColumn();

  const existing = lastRow > 1
    ? sheet.getRange(2, phoneIdCol, lastRow - 1, 1).getValues().flat().map(String)
    : [];
  const existingSet = new Set(existing);

  const rows = [];
  for (const r of records) {
    const localId = String(r.id || '');
    if (localId && existingSet.has(localId)) continue;

    // Identity comes from the server-side token, not from the phone.
    rows.push([
      session.user_id,
      session.user_name,
      r.account_id || '',
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
  }

  if (rows.length) {
    sheet.getRange(sheet.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return json_({success:true, uploaded:rows.length, user_id:session.user_id});
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
