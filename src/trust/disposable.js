// Throwaway-inbox domains refused at sign-up (docs/decisions/003). A starter copy of the best-known ones from the CC0
// list at github.com/disposable-email-domains/disposable-email-domains (disposable_email_blocklist.conf), kept by hand:
// refresh it monthly by pasting in the newer list (one domain per line, lower case). A domain on it also covers its
// subdomains. ALLOW overrides it for a domain that stopped being disposable or that real members use.
// Relay aliases (iCloud Hide My Email, Firefox Relay, SimpleLogin, DuckDuckGo) are not on it: they forward to a real
// person's inbox, and the owner didn't ask to block them.
export const DISPOSABLE = new Set(`
0-mail.com 0815.ru 10minutemail.com 10minutemail.net 10minutemail.co.uk 10minmail.com 20minutemail.com 20minutemail.it
33mail.com 1secmail.com 1secmail.net 1secmail.org 2prong.com 30minutemail.com 3d-painting.com 7tags.com 99experts.com
anonbox.net anonymbox.com antispam.de armyspy.com bccto.me binkmail.com bobmail.info bofthew.com boximail.com
burnermail.io byom.de chacuo.net cool.fr.nf courriel.fr.nf crazymailing.com cuvox.de dayrep.com
deadaddress.com despam.it disposableaddress.com disposableemailaddresses.com disposableinbox.com dispostable.com
dodgeit.com dodgit.com dropmail.me dumpmail.de e4ward.com emailondeck.com emailfake.com email-fake.com emailtemporanea.net
emailtemporario.com.br emailtmp.com emltmp.com ephemail.net eyepaste.com fakeinbox.com fakemail.net fakemailgenerator.com
fastacura.com filzmail.com fleckens.hu getairmail.com getnada.com nada.email gishpuppy.com grr.la guerrillamail.biz
guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com
gustr.com harakirimail.com hulapla.de imgof.com incognitomail.com incognitomail.org inboxalias.com inboxbear.com
inboxkitten.com jetable.com jetable.fr.nf jetable.net jetable.org jourrapide.com kasmail.com killmail.com klzlk.com
koszmail.pl kurzepost.de linshiyouxiang.net lroid.com mail-temp.com mail.tm mail7.io mailcatch.com maildrop.cc
mailexpire.com mailforspam.com mailimate.com mailinater.com mailinator.com mailinator.net mailinator.org mailinator2.com
mailnesia.com mailnull.com mailpoof.com mailsac.com mailtemp.info mailtothis.com meltmail.com mintemail.com moakt.com
moakt.cc mohmal.com mt2015.com mvrht.com mytemp.email mytrashmail.com nepwk.com no-spam.ws noclickemail.com nomail.xl.cx
nowmymail.com objectmail.com obobbo.com oneoffemail.com pokemail.net proxymail.eu putthisinyourspamdatabase.com
quickinbox.com rcpt.at rhyta.com rmqkr.net s0ny.net safetymail.info sharklasers.com shieldemail.com
shitmail.me sofort-mail.de spam4.me spamavert.com spambog.com spambox.us spamex.com spamfree24.org spamgourmet.com
spamherelots.com spamhole.com spaml.de spammotel.com spamspot.com superrito.com suremail.info teleworm.us temp-mail.io
temp-mail.org temp-mail.ru tempail.com tempemail.co tempemail.net tempinbox.com tempmail.de tempmail.dev tempmail.net
tempmail.plus tempmailo.com tempmailaddress.com tempr.email tempsky.com tempymail.com throwam.com throwawayemailaddress.com
throwawaymail.com tmail.ws tmailinator.com tmpmail.net tmpmail.org trash-mail.at trash-mail.com trash-mail.de
trash2009.com trashmail.at trashmail.com trashmail.de trashmail.io trashmail.me trashmail.net trashmail.org trashmail.ws
trashymail.com trbvm.com tyldd.com uggsrock.com veryrealemail.com wegwerfemail.de wegwerfmail.de wegwerfmail.net
wegwerfmail.org wh4f.org yepmail.net yopmail.com yopmail.fr yopmail.net zetmail.com zoemail.org
`.trim().split(/\s+/));

// domains taken off the list on purpose (none yet)
export const ALLOW = new Set([]);

// Mail providers lots of people share. A sign-up wave from one of these says nothing; from a small or unfamiliar
// domain it adds a risk point (src/trust/risk.js), and the nightly check looks at it (src/trust/clusters.js).
export const CONSUMER = new Set(`
gmail.com googlemail.com outlook.com hotmail.com hotmail.co.uk live.com msn.com yahoo.com yahoo.co.uk ymail.com
icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.de gmx.net web.de mail.com yandex.com
yandex.ru zoho.com fastmail.com hey.com tutanota.com tuta.io qq.com 163.com 126.com naver.com orange.fr free.fr
comcast.net verizon.net att.net sbcglobal.net btinternet.com virginmedia.com t-online.de libero.it duck.com
privaterelay.appleid.com mozmail.com simplelogin.com
`.trim().split(/\s+/));
