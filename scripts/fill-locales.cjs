#!/usr/bin/env node
/* eslint-disable */
/**
 * Fills locale files (kn/ml/mr/ta/te) with missing verify.* and transport
 * keys present in en.json. Idempotent: run again after adding more keys and
 * it will only patch what's missing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'locales');

const T = {
  kn: {
    'verify.title': 'ನಿಮ್ಮ ಖಾತೆಯನ್ನು ಪರಿಶೀಲಿಸಿ',
    'verify.subtitle': 'IstaSeva ಬಳಸಲು ನಿಮ್ಮ ಇಮೇಲ್ ಮತ್ತು ಫೋನ್ ಪರಿಶೀಲಿಸಬೇಕು.',
    'verify.email.heading': 'ಇಮೇಲ್ ಪರಿಶೀಲನೆ',
    'verify.email.verified': 'ಪರಿಶೀಲಿಸಲಾಗಿದೆ',
    'verify.email.body': 'ನಾವು {{email}} ಗೆ ಪರಿಶೀಲನಾ ಲಿಂಕ್ ಕಳುಹಿಸಿದ್ದೇವೆ. ನಿಮ್ಮ ಇನ್ಬಾಕ್ಸ್ ಖಚಿತಪಡಿಸಲು ಅದನ್ನು ಕ್ಲಿಕ್ ಮಾಡಿ.',
    'verify.email.verifiedBody': '{{email}} ಪರಿಶೀಲಿಸಲಾಗಿದೆ.',
    'verify.email.yourInbox': 'ನಿಮ್ಮ ಇನ್ಬಾಕ್ಸ್',
    'verify.email.resend': 'ಪರಿಶೀಲನಾ ಇಮೇಲ್ ಮತ್ತೆ ಕಳುಹಿಸಿ',
    'verify.email.resent': 'ಪರಿಶೀಲನಾ ಇಮೇಲ್ ಮತ್ತೆ ಕಳುಹಿಸಲಾಗಿದೆ',
    'verify.email.resendFail': 'ಪರಿಶೀಲನಾ ಇಮೇಲ್ ಮತ್ತೆ ಕಳುಹಿಸಲು ವಿಫಲ',
    'verify.phone.heading': 'ಫೋನ್ ಪರಿಶೀಲನೆ',
    'verify.phone.verified': 'ಪರಿಶೀಲಿಸಲಾಗಿದೆ',
    'verify.phone.body': 'ನಿಮ್ಮ ಸಂಖ್ಯೆಯನ್ನು ಖಚಿತಪಡಿಸಲು ನಾವು ಒಂದು-ಬಾರಿಯ SMS ಕೋಡ್ ಕಳುಹಿಸುತ್ತೇವೆ.',
    'verify.phone.verifiedBody': 'ನಿಮ್ಮ ಫೋನ್ ಸಂಖ್ಯೆ ಪರಿಶೀಲಿಸಲಾಗಿದೆ.',
    'verify.phone.numberLabel': 'ಫೋನ್ ಸಂಖ್ಯೆ',
    'verify.phone.send': 'SMS ಕೋಡ್ ಕಳುಹಿಸಿ',
    'verify.phone.sending': 'ಕಳುಹಿಸುತ್ತಿದೆ...',
    'verify.phone.codeLabel': 'ಪರಿಶೀಲನಾ ಕೋಡ್',
    'verify.phone.codePlaceholder': '6-ಅಂಕಿಯ ಕೋಡ್',
    'verify.phone.verify': 'ಫೋನ್ ಪರಿಶೀಲಿಸಿ',
    'verify.phone.verifying': 'ಪರಿಶೀಲಿಸುತ್ತಿದೆ...',
    'verify.phone.changeNumber': 'ಸಂಖ್ಯೆ ಬದಲಾಯಿಸಿ ಅಥವಾ ಮತ್ತೆ ಕಳುಹಿಸಿ',
    'verify.phone.sendFail': 'OTP ಕಳುಹಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ',
    'verify.phone.sent': '{{phone}} ಗೆ OTP ಕಳುಹಿಸಲಾಗಿದೆ',
    'verify.phone.verifyFail': 'OTP ಪರಿಶೀಲನೆ ವಿಫಲವಾಯಿತು. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    'verify.phone.success': 'ಫೋನ್ ಯಶಸ್ವಿಯಾಗಿ ಪರಿಶೀಲಿಸಲಾಗಿದೆ!',
    'transportPage.type.Van': 'ವ್ಯಾನ್',
    'transportPage.type.Tempo / Pickup': 'ಟೆಂಪೋ / ಪಿಕಪ್',
  },
  ml: {
    'verify.title': 'നിങ്ങളുടെ അക്കൗണ്ട് പരിശോധിക്കുക',
    'verify.subtitle': 'IstaSeva ഉപയോഗിക്കാൻ നിങ്ങളുടെ ഇമെയിലും ഫോണും ഉറപ്പിക്കണം.',
    'verify.email.heading': 'ഇമെയിൽ പരിശോധന',
    'verify.email.verified': 'പരിശോധിച്ചു',
    'verify.email.body': '{{email}} എന്നതിലേക്ക് ഞങ്ങൾ ഒരു പരിശോധനാ ലിങ്ക് അയച്ചു. ഇൻബോക്സ് ഉറപ്പിക്കാൻ അതിൽ ക്ലിക്കുചെയ്യുക.',
    'verify.email.verifiedBody': '{{email}} പരിശോധിച്ചു.',
    'verify.email.yourInbox': 'നിങ്ങളുടെ ഇൻബോക്സ്',
    'verify.email.resend': 'പരിശോധനാ ഇമെയിൽ വീണ്ടും അയയ്ക്കുക',
    'verify.email.resent': 'പരിശോധനാ ഇമെയിൽ വീണ്ടും അയച്ചു',
    'verify.email.resendFail': 'പരിശോധനാ ഇമെയിൽ അയയ്ക്കാനായില്ല',
    'verify.phone.heading': 'ഫോൺ പരിശോധന',
    'verify.phone.verified': 'പരിശോധിച്ചു',
    'verify.phone.body': 'നിങ്ങളുടെ നമ്പർ സ്ഥിരീകരിക്കാൻ ഞങ്ങൾ ഒറ്റത്തവണ SMS കോഡ് അയയ്ക്കും.',
    'verify.phone.verifiedBody': 'നിങ്ങളുടെ ഫോൺ നമ്പർ പരിശോധിച്ചു.',
    'verify.phone.numberLabel': 'ഫോൺ നമ്പർ',
    'verify.phone.send': 'SMS കോഡ് അയയ്ക്കുക',
    'verify.phone.sending': 'അയയ്ക്കുന്നു...',
    'verify.phone.codeLabel': 'പരിശോധനാ കോഡ്',
    'verify.phone.codePlaceholder': '6-അക്ക കോഡ്',
    'verify.phone.verify': 'ഫോൺ പരിശോധിക്കുക',
    'verify.phone.verifying': 'പരിശോധിക്കുന്നു...',
    'verify.phone.changeNumber': 'നമ്പർ മാറ്റുക അല്ലെങ്കിൽ വീണ്ടും അയയ്ക്കുക',
    'verify.phone.sendFail': 'OTP അയയ്ക്കാനായില്ല',
    'verify.phone.sent': '{{phone}} എന്നതിലേക്ക് OTP അയച്ചു',
    'verify.phone.verifyFail': 'OTP പരിശോധന പരാജയപ്പെട്ടു. വീണ്ടും ശ്രമിക്കുക.',
    'verify.phone.success': 'ഫോൺ വിജയകരമായി പരിശോധിച്ചു!',
    'transportPage.type.Van': 'വാൻ',
    'transportPage.type.Tempo / Pickup': 'ടെംപോ / പിക്കപ്പ്',
  },
  mr: {
    'verify.title': 'तुमचे खाते सत्यापित करा',
    'verify.subtitle': 'IstaSeva वापरण्यापूर्वी आम्हाला तुमचा ईमेल आणि फोन सत्यापित करावा लागेल.',
    'verify.email.heading': 'ईमेल सत्यापन',
    'verify.email.verified': 'सत्यापित',
    'verify.email.body': 'आम्ही {{email}} वर सत्यापन दुवा पाठवला आहे. तुमचा इनबॉक्स पुष्टी करण्यासाठी त्यावर क्लिक करा.',
    'verify.email.verifiedBody': '{{email}} सत्यापित आहे.',
    'verify.email.yourInbox': 'तुमचा इनबॉक्स',
    'verify.email.resend': 'सत्यापन ईमेल पुन्हा पाठवा',
    'verify.email.resent': 'सत्यापन ईमेल पुन्हा पाठवला',
    'verify.email.resendFail': 'सत्यापन ईमेल पाठवता आला नाही',
    'verify.phone.heading': 'फोन सत्यापन',
    'verify.phone.verified': 'सत्यापित',
    'verify.phone.body': 'तुमचा क्रमांक पुष्टी करण्यासाठी आम्ही एक-वेळचा SMS कोड पाठवू.',
    'verify.phone.verifiedBody': 'तुमचा फोन क्रमांक सत्यापित आहे.',
    'verify.phone.numberLabel': 'फोन क्रमांक',
    'verify.phone.send': 'SMS कोड पाठवा',
    'verify.phone.sending': 'पाठवत आहे...',
    'verify.phone.codeLabel': 'सत्यापन कोड',
    'verify.phone.codePlaceholder': '6-अंकी कोड',
    'verify.phone.verify': 'फोन सत्यापित करा',
    'verify.phone.verifying': 'सत्यापित करत आहे...',
    'verify.phone.changeNumber': 'क्रमांक बदला किंवा पुन्हा पाठवा',
    'verify.phone.sendFail': 'OTP पाठवता आला नाही',
    'verify.phone.sent': '{{phone}} वर OTP पाठवला',
    'verify.phone.verifyFail': 'OTP सत्यापन अयशस्वी. पुन्हा प्रयत्न करा.',
    'verify.phone.success': 'फोन यशस्वीरित्या सत्यापित झाला!',
    'transportPage.type.Van': 'व्हॅन',
    'transportPage.type.Tempo / Pickup': 'टेम्पो / पिकअप',
  },
  ta: {
    'verify.title': 'உங்கள் கணக்கை சரிபார்க்கவும்',
    'verify.subtitle': 'IstaSeva-வைப் பயன்படுத்த முன், உங்கள் மின்னஞ்சல் மற்றும் தொலைபேசியை சரிபார்க்க வேண்டும்.',
    'verify.email.heading': 'மின்னஞ்சல் சரிபார்ப்பு',
    'verify.email.verified': 'சரிபார்க்கப்பட்டது',
    'verify.email.body': '{{email}} க்கு சரிபார்ப்பு இணைப்பை அனுப்பினோம். உங்கள் இன்பாக்ஸை உறுதிசெய்ய அதைக் கிளிக் செய்க.',
    'verify.email.verifiedBody': '{{email}} சரிபார்க்கப்பட்டது.',
    'verify.email.yourInbox': 'உங்கள் இன்பாக்ஸ்',
    'verify.email.resend': 'சரிபார்ப்பு மின்னஞ்சலை மீண்டும் அனுப்பு',
    'verify.email.resent': 'சரிபார்ப்பு மின்னஞ்சல் மீண்டும் அனுப்பப்பட்டது',
    'verify.email.resendFail': 'சரிபார்ப்பு மின்னஞ்சல் அனுப்ப முடியவில்லை',
    'verify.phone.heading': 'தொலைபேசி சரிபார்ப்பு',
    'verify.phone.verified': 'சரிபார்க்கப்பட்டது',
    'verify.phone.body': 'உங்கள் எண்ணை உறுதிசெய்ய ஒரு முறை மட்டுமே செயல்படும் SMS குறியீட்டை அனுப்புவோம்.',
    'verify.phone.verifiedBody': 'உங்கள் தொலைபேசி எண் சரிபார்க்கப்பட்டது.',
    'verify.phone.numberLabel': 'தொலைபேசி எண்',
    'verify.phone.send': 'SMS குறியீட்டை அனுப்பு',
    'verify.phone.sending': 'அனுப்புகிறது...',
    'verify.phone.codeLabel': 'சரிபார்ப்பு குறியீடு',
    'verify.phone.codePlaceholder': '6-இலக்க குறியீடு',
    'verify.phone.verify': 'தொலைபேசியை சரிபார்',
    'verify.phone.verifying': 'சரிபார்க்கிறது...',
    'verify.phone.changeNumber': 'எண்ணை மாற்று அல்லது மீண்டும் அனுப்பு',
    'verify.phone.sendFail': 'OTP அனுப்ப முடியவில்லை',
    'verify.phone.sent': '{{phone}} க்கு OTP அனுப்பப்பட்டது',
    'verify.phone.verifyFail': 'OTP சரிபார்ப்பு தோல்வி. மீண்டும் முயற்சிக்கவும்.',
    'verify.phone.success': 'தொலைபேசி வெற்றிகரமாக சரிபார்க்கப்பட்டது!',
    'transportPage.type.Van': 'வேன்',
    'transportPage.type.Tempo / Pickup': 'டெம்போ / பிக்கப்',
  },
  te: {
    'verify.title': 'మీ ఖాతాను ధృవీకరించండి',
    'verify.subtitle': 'IstaSeva ఉపయోగించడానికి ముందు మీ ఇమెయిల్ మరియు ఫోన్‌ను నిర్ధారించాలి.',
    'verify.email.heading': 'ఇమెయిల్ ధృవీకరణ',
    'verify.email.verified': 'ధృవీకరించబడింది',
    'verify.email.body': 'మేము {{email}} కి ధృవీకరణ లింక్‌ను పంపాము. మీ ఇన్‌బాక్స్‌ను నిర్ధారించడానికి దానిని క్లిక్ చేయండి.',
    'verify.email.verifiedBody': '{{email}} ధృవీకరించబడింది.',
    'verify.email.yourInbox': 'మీ ఇన్‌బాక్స్',
    'verify.email.resend': 'ధృవీకరణ ఇమెయిల్‌ను మళ్లీ పంపండి',
    'verify.email.resent': 'ధృవీకరణ ఇమెయిల్ మళ్లీ పంపబడింది',
    'verify.email.resendFail': 'ధృవీకరణ ఇమెయిల్‌ను పంపలేకపోయాము',
    'verify.phone.heading': 'ఫోన్ ధృవీకరణ',
    'verify.phone.verified': 'ధృవీకరించబడింది',
    'verify.phone.body': 'మీ సంఖ్యను నిర్ధారించడానికి మేము ఒక-సారి SMS కోడ్‌ను పంపుతాము.',
    'verify.phone.verifiedBody': 'మీ ఫోన్ సంఖ్య ధృవీకరించబడింది.',
    'verify.phone.numberLabel': 'ఫోన్ సంఖ్య',
    'verify.phone.send': 'SMS కోడ్ పంపండి',
    'verify.phone.sending': 'పంపుతోంది...',
    'verify.phone.codeLabel': 'ధృవీకరణ కోడ్',
    'verify.phone.codePlaceholder': '6-అంకెల కోడ్',
    'verify.phone.verify': 'ఫోన్‌ను ధృవీకరించండి',
    'verify.phone.verifying': 'ధృవీకరిస్తోంది...',
    'verify.phone.changeNumber': 'సంఖ్యను మార్చండి లేదా మళ్లీ పంపండి',
    'verify.phone.sendFail': 'OTP పంపలేకపోయాము',
    'verify.phone.sent': '{{phone}} కి OTP పంపబడింది',
    'verify.phone.verifyFail': 'OTP ధృవీకరణ విఫలమైంది. మళ్లీ ప్రయత్నించండి.',
    'verify.phone.success': 'ఫోన్ విజయవంతంగా ధృవీకరించబడింది!',
    'transportPage.type.Van': 'వాన్',
    'transportPage.type.Tempo / Pickup': 'టెంపో / పికప్',
  },
};

const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'en.json'), 'utf8'));
const enKeys = Object.keys(en);

for (const loc of Object.keys(T)) {
  const file = path.join(ROOT, loc + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0;
  // Re-emit in the same order as en.json so the diff stays clean.
  const next = {};
  for (const k of enKeys) {
    if (data[k] !== undefined) {
      next[k] = data[k];
    } else if (T[loc][k] !== undefined) {
      next[k] = T[loc][k];
      added++;
    } else if (en[k] !== undefined) {
      next[k] = en[k];
      added++;
    }
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  console.log(loc, '+'+added+' keys');
}
