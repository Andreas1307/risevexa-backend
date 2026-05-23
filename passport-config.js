const bcrypt = require("bcrypt");
  const LocalStrategy = require("passport-local").Strategy;

  function initialize(passport, getUserByEmail, getUserById) {
    // Authentication function
    const authenticateUser = async (email, password, done) => {
      try {
        const user = await getUserByEmail(email);
  
        if (!user) {
          return done(null, false, { message: "No user with that email" });
        }
  
        const match = await bcrypt.compare(password, user.password);
        if (match) {
          return done(null, user);
        } else {
          return done(null, false, { message: "Password incorrect" });
        }
      } catch (e) {
        return done(e);
      }
    };
  
    // ✅ Local strategy only
    passport.use(new LocalStrategy({ usernameField: "email" }, authenticateUser));
  
    // Serialize/deserialize user
    passport.serializeUser((user, done) => done(null, user.id));
    passport.deserializeUser(async (id, done) => {
      try {
        const user = await getUserById(id);
        if (!user) {
          return done(null, false); // Prevents errors if user deleted
        }
        return done(null, user);
      } catch (e) {
        return done(e, null);
      }
    });
  }
  
  module.exports = initialize;
  