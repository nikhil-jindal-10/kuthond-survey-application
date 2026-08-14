const SHEET_NAME = 'Mobile Data';
const USERS_SHEET = 'Users';
const SESSION_TTL_SECONDS = 21600; // 6 hours

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

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.appendRow(['User ID','User Name','Password Hash','Active']);
    // First setup account. Change/remove this row after creating real users.
    sheet.appendRow(['admin','Administrator',sha256_('admin123'),'YES']);
  }

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowUser = String(data[i][0] || '').trim();
    const rowName = String(data[i][1] || '').trim();
    const rowHash = String(data[i][2] || '').trim();
    const active = String(data[i][3] || '').trim().toUpperCase();

    if (rowUser.toLowerCase() === userId.toLowerCase() &&
        active === 'YES' &&
        rowHash === sha256_(password)) {

      const token = Utilities.getUuid() + Utilities.getUuid();
      CacheService.getScriptCache().put(
        'session_' + token,
        JSON.stringify({user_id:rowUser, user_name:rowName}),
        SESSION_TTL_SECONDS
      );

      return json_({
        success:true,
        token:token,
        user_id:rowUser,
        user_name:rowName
      });
    }
  }

  return json_({success:false, message:'Invalid User ID or Password.'});
}

function upload_(body) {
  const session = getSession_(String(body.token || ''));
  if (!session) {
    return json_({success:false, code:'AUTH', message:'Login expired or invalid. Please login again.'});
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

    // Always take identity from authenticated session, not from the phone.
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
    // For a previous V5 sheet, rebuild header row while preserving existing rows is
    // safer than deleting data. Existing rows get blank User ID/Meter Condition if
    // those fields did not exist before.
    sheet.insertColumnsBefore(1, 2);
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  } else if (existing.length < headers.length) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
}

function getSession_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('session_' + token);
  return raw ? JSON.parse(raw) : null;
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
