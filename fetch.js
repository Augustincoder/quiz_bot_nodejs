const https = require('https');
const fs = require('fs');

console.log("⏳ 1-qadam: EduPage'dan ruxsat (Cookie) olinmoqda...");

// 1. Python'dagi kabi params bilan GET so'rov
const getOptions = {
  hostname: 'tsue.edupage.org',
  path: '/timetable/view.php?num=91&class=*3', 
  method: 'GET',
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
};

https.get(getOptions, (res1) => {
  const cookies = res1.headers['set-cookie'];
  let cookieString = '';
  if (cookies) {
     cookieString = cookies.map(c => c.split(';')[0]).join('; ');
  }

  console.log("✅ Cookie olindi. 2-qadam: Guruhlar ro'yxati tortilmoqda...");

  // Python'dagi TESTED WORKING PAYLOAD
  const payload = JSON.stringify({
    __args: [null, "91"],
    __gsh: "00000000"
  });

  // 2. Python'dagi kabi POST so'rov (__func ga e'tibor bering!)
  const postOptions = {
    hostname: 'tsue.edupage.org',
    path: '/timetable/server/regulartt.js?__func=regularttGetData', 
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://tsue.edupage.org',
      'Referer': 'https://tsue.edupage.org', 
      'Cookie': cookieString
    }
  };

  const req = https.request(postOptions, (res2) => {
    let data = '';
    res2.on('data', (chunk) => data += chunk);
    
    res2.on('end', () => {
      try {
        const json = JSON.parse(data);
        
        if (!json || !json.r || !json.r.dbiAccessorRes) {
            console.error("❌ Tizim baribir rad etdi. Server javobi:\n", data.substring(0, 300));
            return;
        }

        const tables = json.r.dbiAccessorRes.tables;
        
        // 'classes' jadvalini topish
        const classesTable = tables.find(t => t.id === 'classes');

        if (classesTable && classesTable.data_rows) {
          const groups = classesTable.data_rows.map(cls => cls.name || cls.short);
          
          fs.writeFileSync('groups.json', JSON.stringify(groups, null, 2), 'utf-8');
          console.log(`🎉 Muvaffaqiyatli! Barcha ${groups.length} ta guruh 'groups.json' fayliga saqlandi.`);
        } else {
          console.log('❌ Xatolik: Guruhlar ro\'yxati topilmadi.');
        }
      } catch (e) {
        console.error("❌ JSON o'qishda xatolik:", e.message);
        console.log("Server javobi:\n", data.substring(0, 300));
      }
    });
  });

  req.on('error', (e) => console.error("Tarmoq xatosi:", e.message));
  req.write(payload);
  req.end();
  
}).on('error', (e) => console.error("Cookie olishda xatolik:", e.message));