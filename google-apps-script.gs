const SHEET_NAME = 'Mobile Data';

function doGet() {
  return json_({success:true, message:'Mobile collection API is running'});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.action !== 'upload') return json_({success:false, message:'Invalid action'});

    const records = body.records || [];
    if (!records.length) return json_({success:true, uploaded:0});

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Account ID','Consumer Name','Father/Husband','Address','Supply Type',
        'Load','SDO Code','Village','Mobile Number','Created At','Phone Record ID'
      ]);
    }

    // Prevent duplicate uploads using the phone-local record ID.
    const lastRow = sheet.getLastRow();
    const existing = lastRow > 1
      ? sheet.getRange(2, 11, lastRow - 1, 1).getValues().flat().map(String)
      : [];
    const existingSet = new Set(existing);

    const rows = [];
    for (const r of records) {
      const localId = String(r.id || '');
      if (localId && existingSet.has(localId)) continue;

      rows.push([
        r.account_id || '',
        r.consumer_name || '',
        r.father_name || '',
        r.address || '',
        r.supply_type || '',
        r.load || '',
        r.sdo_code || '',
        r.village || '',
        r.mobile_number || '',
        r.created_at || '',
        localId
      ]);
    }

    if (rows.length) sheet.getRange(sheet.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);

    return json_({success:true, uploaded:rows.length});
  } catch (err) {
    return json_({success:false, message:String(err)});
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
